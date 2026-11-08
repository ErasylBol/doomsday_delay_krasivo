// CLI: оценить набор диалогов моделью и выгрузить results.json в формате организаторов (приложение к гайду, JSON 1.0).
//   node scripts/export-results.mjs --group FBroker --out results/prod/results.json [--team "Команда"] [--checklist default]
// Нужен запущенный сервис модели: local-model\.venv\Scripts\python.exe local-model\serve.py
//
// Правила формата:
// - один объект на диалог, ID как в API; при сбое — status "error", criteria [], score null, причина в error;
// - value: true/false/null (N/A) или число по шкале критерия, до учёта веса;
// - evidence_turns нумеруются с 1 по исходному массиву transcript (у нас внутри индексы с 0);
// - final_score — итог 0..100 с перераспределением веса N/A (server/scoring.js), critical_flag = value критерия critical.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateConversation } from '../server/model/evaluate.js';
import { createLocalModel } from '../server/model/decide.js';
import { toAnswer } from '../server/model/questions.js';
import { computeScore } from '../server/scoring.js';
import * as store from '../server/store.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1] ?? true]] : acc), []),
);
const group = args.group || 'FBroker';
const file = args.file || `data/${group}.json`;
const out = args.out || 'results/prod/results.json';
const team = args.team || process.env.CQA_TEAM_NAME || 'Vamp Vibe Coders';

// коды критериев организаторов ↔ id стартового чек-листа (server/seed/checklist.default.json)
const CODES = { c01: 'contact', c02: 'discovery', c03: 'identification', c04: 'consultation', c05: 'empathy', c06: 'dialogue', c07: 'closure', c08: 'critical' };

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const records = raw?.data?.records || raw?.records || raw;
const checklist = store.getChecklist(args.checklist || 'default');
if (!checklist) throw new Error(`Чек-лист ${args.checklist} не найден`);
const missing = Object.keys(CODES).filter((id) => !checklist.criteria.some((c) => c.id === id));
if (missing.length) throw new Error(`В чек-листе нет критериев ${missing.join(', ')}`);
const model = createLocalModel();

// 0-based ссылки шаблонного объяснения («[5] operator: …», «[3–9]») → нумерация организаторов с 1
const oneBased = (s) => String(s || '')
  .replace(/\[(\d+)–(\d+)\]/g, (_, a, b) => `${+a + 1}–${+b + 1}`)
  .replace(/\[(\d+)\] (\w+):/g, (_, i, sp) => `реплика ${+i + 1} (${sp}):`)
  .replace('Ключевая реплика: реплика', 'Ключевая реплика');

const valueOf = (c, answer) => {
  if (answer === 'na') return null;
  if (c.type === 'scale') return Number(answer);
  return answer === 'yes';
};

/** Ответ «manual» (модель выбрала недопустимый вариант) → самый вероятный допустимый вариант, иначе null. */
function fallbackAnswer(c, r) {
  const ranked = Object.entries(r.probabilities || {}).sort((a, b) => b[1] - a[1]);
  for (const [key] of ranked) {
    const ans = toAnswer(c, key);
    if (ans !== null && (ans !== 'na' || c.na_allowed)) return ans;
  }
  return null;
}

function toResult(record, ev) {
  const criteria = [];
  const results = ev.results.map((r) => ({ ...r }));
  for (const r of results) {
    const c = checklist.criteria.find((x) => x.id === r.criterion_id);
    if (!CODES[c.id]) continue;
    if (r.answer === 'manual') {
      const ans = fallbackAnswer(c, r);
      if (ans === null) throw new Error(`Модель не дала допустимого ответа по критерию ${CODES[c.id]}`);
      r.answer = ans;
      r.explanation = `Модель не дала однозначного ответа, взят самый вероятный допустимый вариант. ${r.explanation}`;
    }
    criteria.push({
      criterion_id: CODES[c.id],
      value: valueOf(c, r.answer),
      rationale: oneBased(r.explanation),
      evidence_turns: (r.evidence || []).map((i) => i + 1),
    });
  }
  const score = computeScore(checklist, results);
  const critical = criteria.find((x) => x.criterion_id === 'critical').value === true;
  if (score.total === null) throw new Error('Все критерии неприменимы — итог не определён');
  return {
    conversation_id: record.conversation_id,
    status: 'ok',
    criteria,
    score: { final_score: score.total, critical_flag: critical },
  };
}

console.log(`Оцениваю ${records.length} диалогов из ${file} · модель ${model.model} · чек-лист ${checklist.id} v${checklist.version}`);
const output = [];
for (const record of records) {
  try {
    const ev = await evaluateConversation({ record, checklist, model, group_id: group });
    store.saveEvaluation(ev); // чтобы оценки были видны и в интерфейсе
    const res = toResult(record, ev);
    output.push(res);
    console.log(`${record.conversation_id}: ${res.score.final_score}${res.score.critical_flag ? ' · ГРУБАЯ ОШИБКА' : ''}`);
  } catch (e) {
    output.push({ conversation_id: record.conversation_id, status: 'error', criteria: [], score: null, error: e.message });
    console.error(`${record.conversation_id}: ОШИБКА ${e.message}`);
  }
}

// проверка перед записью: одна запись на диалог, без повторов, все 8 критериев ровно по разу, допустимые значения
const ALLOWED = {
  contact: [true, false], discovery: [true, false, null], identification: [true, false, null],
  consultation: [0, 5, 10, 15, 20, null], empathy: [true, false], dialogue: [0, 4, 7, 10],
  closure: [true, false, null], critical: [true, false],
};
const ids = output.map((r) => r.conversation_id);
if (new Set(ids).size !== ids.length) throw new Error('Повторяющиеся conversation_id');
if (ids.length !== records.length) throw new Error('Не все диалоги попали в результат');
for (const r of output.filter((x) => x.status === 'ok')) {
  const codes = r.criteria.map((c) => c.criterion_id);
  if (codes.length !== 8 || new Set(codes).size !== 8) throw new Error(`${r.conversation_id}: нужны все 8 критериев по одному разу`);
  for (const c of r.criteria) {
    if (!ALLOWED[c.criterion_id].includes(c.value)) throw new Error(`${r.conversation_id}: ${c.criterion_id} = ${c.value} вне шкалы`);
  }
  if (r.score.critical_flag !== (r.criteria.find((c) => c.criterion_id === 'critical').value === true)) throw new Error(`${r.conversation_id}: critical_flag`);
}

const doc = { schema_version: '1.0', team_name: team, model: { mode: 'local', name: model.model }, results: output };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
const errors = output.filter((r) => r.status === 'error').length;
console.log(`Записано ${out}: ${output.length} записей, ошибок ${errors}.`);
