'use strict';
const {requireValue} = require('./values.cjs');
function calendarDate(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '0001-01-01', 'INVALID_CALENDAR_DATE');
  const date = new Date(value + 'T00:00:00.000Z');
  requireValue(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value, 'INVALID_CALENDAR_DATE');
  return value;
}
function addDays(value, days) {
  calendarDate(value);
  requireValue(Number.isSafeInteger(days), 'INVALID_DAY_OFFSET');
  const date = new Date(value + 'T00:00:00.000Z');
  date.setUTCDate(date.getUTCDate() + days);
  requireValue(Number.isFinite(date.getTime()), 'DATE_OUT_OF_RANGE');
  return calendarDate(date.toISOString().slice(0, 10));
}
function interval(from, until = null) {
  calendarDate(from);
  if (until !== null) { calendarDate(until); requireValue(until > from, 'INVALID_INTERVAL'); }
  return {effectiveFrom: from, effectiveUntil: until};
}
function contains(date, from, until = null) {
  calendarDate(date); interval(from, until);
  return date >= from && (until === null || date < until);
}
module.exports = {calendarDate, addDays, interval, contains};
