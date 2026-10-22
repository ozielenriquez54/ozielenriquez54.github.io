'use strict';
class DomainError extends Error {
  constructor(code, message = code) { super(message); this.name = 'DomainError'; this.code = code; }
}
function requireValue(condition, code) { if (!condition) throw new DomainError(code); }
function id(value, field = 'ID') { requireValue(typeof value === 'string' && value.trim().length > 0, 'INVALID_' + field); return value; }
function number(value, field, {positive = false} = {}) {
  requireValue(typeof value === 'number' && Number.isFinite(value) && (positive ? value > 0 : value >= 0) && value <= Number.MAX_SAFE_INTEGER, 'INVALID_' + field);
  return value;
}
function immutable(value) {
  const copy = structuredClone(value);
  function freeze(item) {
    if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); }
    return item;
  }
  return freeze(copy);
}
function instant(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value), 'INVALID_INSTANT');
  const parsed = new Date(value);
  requireValue(Number.isFinite(parsed.getTime()) && parsed.toISOString() === value.replace(/(?<=:\d{2})Z$/, '.000Z'), 'INVALID_INSTANT');
  return value;
}
module.exports = {DomainError, requireValue, id, number, immutable, instant};
