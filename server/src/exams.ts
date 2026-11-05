/** Справочник экзаменов (ТЗ СЧ, 6.7): продолжительность и вид шкалы. */
export const EXAMS: Record<string, { title: string; short: string; durationMin: number; scale: 'test' | 'grade' }> = {
  'math-profile': { title: 'Математика (профильный уровень)', short: 'Математика П', durationMin: 235, scale: 'test' },
  'math-base': { title: 'Математика (базовый уровень)', short: 'Математика Б', durationMin: 180, scale: 'grade' },
};

export const INCIDENT_TYPES = [
  'Использование средств связи',
  'Использование справочных материалов',
  'Выход из аудитории без сопровождения',
  'Перемещение по аудитории',
  'Разговоры и обмен материалами',
  'Фото- или видеосъёмка КИМ',
];

export const COMPENSATION_REASONS = [
  'Сбой рабочего места',
  'Перебои электропитания',
  'Сбой сети ППЭ',
  'Перевод на другое рабочее место',
];

export const EARLY_FINISH_REASONS = ['Ухудшение самочувствия', 'Медицинская помощь', 'Иные объективные причины'];
