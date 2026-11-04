import { useEffect, useRef, useState } from 'react';
import type { TaskView } from '../../../../shared/types';
import { filterShortInput, FORMAT_HINT } from '../../../../shared/format';
import { Icon } from '../../components/Icon';
import { Brand, Modal } from '../../components/ui';
import { Formula, SafeHtml } from '../../lib/richtext';
import { fmtDuration, fmtTime, plural } from '../../lib/format';
import type { ExamEngine } from './useExam';
import './exam.css';

/** Подсказка формата под полем ответа (D.2): в КИМ ответ — целое число или конечная десятичная дробь. */
const DECIMAL_HINT = 'Целое число или конечная десятичная дробь, например −3 или 0,25';