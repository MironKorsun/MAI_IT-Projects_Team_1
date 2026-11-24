import type { FastifyInstance } from 'fastify';
import type { KimSelection } from '../../../shared/kim';
import { requireStaff } from '../auth';
import { audit } from '../audit';
import { db, persist } from '../db';
import { ApiError, invalid } from '../errors';
import { sha256 } from '../util';
import { buildBankSelection, kimBank } from '../kim/bank';
import { buildVariant } from '../kim/loader';
import { MAX_ZIP_BYTES, readKimArchive } from '../kim/package';

const archiveBody = {
  type: 'object', additionalProperties: false, required: ['archive'],
  properties: { archive: { type: 'string', minLength: 4, maxLength: 4 * Math.ceil(MAX_ZIP_BYTES / 3), pattern: '^[A-Za-z0-9+/]+={0,2}$' } },
};

const selectionBody = {
  type: 'object', additionalProperties: false, required: ['number', 'taskIds'],
  properties: {
    number: { type: 'integer', minimum: 1, maximum: 100_000 },
    version: { type: 'string', maxLength: 24, pattern: '^\\d+\\.\\d+\\.\\d+$' },
    taskIds: { type: 'array', minItems: 12, maxItems: 12, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64 } },
  },
};

export default async function kimRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireStaff('admin') };
  const selection = { ...admin, schema: { body: selectionBody } };
  const upload = { ...admin, bodyLimit: archiveBody.properties.archive.maxLength + 64, schema: { body: archiveBody } };

  app.get('/kim/editor', { preHandler: requireStaff('admin', 'observer') }, async () => kimBank().info);

  app.get<{ Params: { position: string }; Querystring: { topic?: string } }>('/kim/editor/candidates/:position', admin, async (req) => {
    const bank = kimBank();
    const position = bank.info.positions.find(p => String(p.number) === req.params.position);
    if (!position) throw new ApiError(404, 'NOT_FOUND', 'Позиция отсутствует в плане');
    const node = bank.tree.nodes.find(n => n.position === position.number);
    return bank.tasks
      .filter(t => t.number === position.number && t.difficulty === position.difficulty
        && position.topic_options.some(o => o.topic_code === t.topic_code)
        && node?.alternatives.some(o => o.topic_code === t.topic_code)
        && (!req.query.topic || t.topic_code === req.query.topic))
      .map(t => ({ id: t.id, topic: t.topic_code, label: t.content.condition.replace(/<[^>]+>/g, '').slice(0, 100) }));
  });

  app.post<{ Body: KimSelection }>('/kim/editor/preview', selection, async req => buildBankSelection(req.body).preview);
  app.post<{ Body: KimSelection }>('/kim/editor/export', selection, async (req, reply) => {
    const archive = buildBankSelection(req.body).archive();
    await readKimArchive(archive);
    return reply.type('application/zip')
      .header('content-disposition', `attachment; filename="kim-variant-${req.body.number}.zip"`)
      .header('x-checksum-sha256', sha256(archive))
      .send(archive);
  });

  app.post<{ Body: { archive: string } }>('/kim/packages/validate', upload, async req => {
    const start = performance.now();
    try {
      const { variant, digest, version } = await readKimArchive(decodeArchive(req.body.archive));
      return { valid: true, errors: [], ms: Math.round(performance.now() - start), digest, version, title: variant.title };
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      return { valid: false, errors: err.extra.errors, ms: Math.round(performance.now() - start) };
    }
  });

  app.post<{ Body: { archive: string } }>('/kim/packages/imports', upload, async (req) => {
    const pkg = await readKimArchive(decodeArchive(req.body.archive));
    const previous = db.variants.find(v => v.packageDigest === pkg.digest);
    if (!previous && db.variants.some(v => v.examCode === pkg.variant.examCode && v.number === pkg.variant.variant && v.packageVersion === pkg.version)) {
      throw new ApiError(409, 'VERSION_MISMATCH', 'Номер и версия уже заняты другим содержимым. Укажите новую версию в редакторе');
    }
    const v = previous ?? buildVariant(pkg.variant, pkg.references, pkg);
    if (!previous) {
      db.variants.push(v);
      audit({
        type: 'kim.imported', category: 'Администрирование', actorRole: 'admin', actorId: req.principal!.sub,
        object: v.title, details: `версия ${pkg.version}, SHA-256 ${pkg.digest}`,
      });
      persist();
    }
    return { id: v.id, number: v.number, title: v.title, tasks: v.keys.length, checksum: v.checksum, packageDigest: pkg.digest, version: pkg.version, reused: !!previous };
  });
}

function decodeArchive(encoded: string): Buffer {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) {
    throw invalid([{ pointer: '/archive', detail: 'Ожидается ZIP, закодированный в base64' }], 'IMPORT_INVALID', 422);
  }
  return bytes;
}
