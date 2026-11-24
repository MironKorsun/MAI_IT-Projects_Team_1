import { writeFileSync } from 'node:fs';
import { buildBankSelection, kimBank } from './bank';
import { readKimArchive } from './package';
import { sha256 } from '../util';

const filename = process.argv[2] ?? 'kim-variant-666.zip';
const archive = buildBankSelection(kimBank().info.demo).archive();
await readKimArchive(archive);
writeFileSync(filename, archive, { flag: 'wx' });
console.log(`${filename} · SHA-256 ${sha256(archive)}`);
