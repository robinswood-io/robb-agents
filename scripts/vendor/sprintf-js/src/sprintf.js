// Generated from sprintf.ts by scripts/build-sprintf-vendor.ts; do not edit.
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var sprintf_exports = {};
__export(sprintf_exports, {
  sprintf: () => sprintf,
  vsprintf: () => vsprintf
});
module.exports = __toCommonJS(sprintf_exports);
const MAX_WIDTH = 1024;
const MAX_PRECISION = 1024;
const MAX_NUMERIC_PRECISION = 100;
const MAX_CACHE_ENTRIES = 1024;
const re = {
  number: /[diefg]/,
  numeric: /[bcdiefguxX]/,
  text: /^[^\x25]+/,
  modulo: /^\x25{2}/,
  placeholder: /^\x25(?:([1-9]\d*)\$|\(([^)]+)\))?(\+)?(0|'[^$])?(-)?(\d+)?(?:\.(\d+))?([b-gijostTuvxX])/,
  key: /^([a-z_][a-z_\d]*)/i,
  keyAccess: /^\.([a-z_][a-z_\d]*)/i,
  indexAccess: /^\[(\d+)\]/
};
const cache = /* @__PURE__ */ new Map();
function property(value, key) {
  if (value === null || value === void 0) {
    throw new TypeError(`Cannot read properties of ${value} (reading '${key}')`);
  }
  const boxed = Object(value);
  const result = Reflect.get(boxed, key);
  return result;
}
function invoke(value, receiver, args) {
  if (typeof value !== "function") throw new TypeError("[sprintf] value is not a function");
  const result = Reflect.apply(value, receiver, args);
  return result;
}
function keysFor(field) {
  let match = re.key.exec(field);
  if (!match?.[1]) throw new SyntaxError("[sprintf] failed to parse named argument key");
  const keys = [match[1]];
  let remaining = field.slice(match[0].length);
  while (remaining) {
    match = re.keyAccess.exec(remaining) ?? re.indexAccess.exec(remaining);
    if (!match?.[1]) throw new SyntaxError("[sprintf] failed to parse named argument key");
    keys.push(match[1]);
    remaining = remaining.slice(match[0].length);
  }
  return keys;
}
function parse(format) {
  const found = cache.get(format);
  if (found) return found;
  let remaining = format;
  const parts = [];
  let argumentNames = 0;
  while (remaining) {
    const literal = re.text.exec(remaining);
    const modulo = re.modulo.exec(remaining);
    if (literal) {
      parts.push(literal[0]);
      remaining = remaining.slice(literal[0].length);
      continue;
    }
    if (modulo) {
      parts.push("%");
      remaining = remaining.slice(modulo[0].length);
      continue;
    }
    const match = re.placeholder.exec(remaining);
    if (!match?.[8]) throw new SyntaxError("[sprintf] unexpected placeholder");
    const keys = match[2] ? keysFor(match[2]) : void 0;
    argumentNames |= keys ? 1 : 2;
    if (argumentNames === 3) {
      throw new Error("[sprintf] mixing positional and named placeholders is not (yet) supported");
    }
    const width = match[6] !== void 0 ? Number.parseInt(match[6], 10) : void 0;
    const precision = match[7] !== void 0 ? Number.parseInt(match[7], 10) : void 0;
    if (width !== void 0 && (Number.isNaN(width) || width > MAX_WIDTH)) {
      throw new RangeError(`[sprintf] width specifier exceeds maximum allowed limit (${MAX_WIDTH})`);
    }
    if (precision !== void 0 && (Number.isNaN(precision) || precision > MAX_PRECISION)) {
      throw new RangeError(`[sprintf] precision specifier exceeds maximum allowed limit (${MAX_PRECISION})`);
    }
    if (re.number.test(match[8]) && precision !== void 0 && precision > MAX_NUMERIC_PRECISION) {
      throw new RangeError(`[sprintf] numeric precision specifier exceeds maximum allowed limit (${MAX_NUMERIC_PRECISION})`);
    }
    parts.push({
      param: match[1],
      keys,
      sign: match[3],
      pad: match[4],
      align: match[5],
      width,
      precision,
      type: match[8]
    });
    remaining = remaining.slice(match[0].length);
  }
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  cache.set(format, parts);
  return parts;
}
function formatParts(parts, argv) {
  let cursor = 1;
  let output = "";
  for (const part of parts) {
    if (typeof part === "string") {
      output += part;
      continue;
    }
    let arg;
    if (part.keys) {
      arg = argv[cursor];
      for (const [index, key] of part.keys.entries()) {
        if (arg === null || arg === void 0) {
          throw new Error(sprintf('[sprintf] Cannot access property "%s" of undefined value "%s"', key, part.keys[index - 1]));
        }
        arg = property(arg, key);
      }
    } else if (part.param) {
      arg = argv[Number(part.param)];
    } else {
      arg = argv[cursor++];
    }
    if (part.type !== "T" && part.type !== "v" && typeof arg === "function") {
      arg = invoke(arg, void 0, []);
    }
    if (re.numeric.test(part.type) && typeof arg !== "number" && invoke(globalThis.isNaN, void 0, [arg]) === true) {
      throw new TypeError(sprintf("[sprintf] expecting number but found %T", arg));
    }
    const numeric = re.number.test(part.type);
    const positive = numeric && Number(arg) >= 0;
    const precision = part.precision;
    switch (part.type) {
      case "b":
        arg = Number.parseInt(`${arg}`, 10).toString(2);
        break;
      case "c":
        arg = String.fromCharCode(Number.parseInt(`${arg}`, 10));
        break;
      case "d":
      case "i":
        arg = Number.parseInt(`${arg}`, 10);
        break;
      case "j":
        arg = JSON.stringify(arg, null, part.width ?? 0);
        break;
      case "e":
        arg = Number.parseFloat(`${arg}`).toExponential(precision);
        break;
      case "f":
        arg = precision !== void 0 ? Number.parseFloat(`${arg}`).toFixed(precision) : Number.parseFloat(`${arg}`);
        break;
      case "g":
        arg = precision !== void 0 ? String(Number(invoke(property(arg, "toPrecision"), arg, [precision]))) : Number.parseFloat(`${arg}`);
        break;
      case "o":
        arg = (Number.parseInt(`${arg}`, 10) >>> 0).toString(8);
        break;
      case "s": {
        const text = String(arg);
        arg = precision !== void 0 ? text.substring(0, precision) : text;
        break;
      }
      case "t": {
        const text = String(Boolean(arg));
        arg = precision !== void 0 ? text.substring(0, precision) : text;
        break;
      }
      case "T": {
        const text = Object.prototype.toString.call(arg).slice(8, -1).toLowerCase();
        arg = precision !== void 0 ? text.substring(0, precision) : text;
        break;
      }
      case "u":
        arg = Number.parseInt(`${arg}`, 10) >>> 0;
        break;
      case "v":
        arg = invoke(property(arg, "valueOf"), arg, []);
        arg = precision !== void 0 ? invoke(property(arg, "substring"), arg, [0, precision]) : arg;
        break;
      case "x":
        arg = (Number.parseInt(`${arg}`, 10) >>> 0).toString(16);
        break;
      case "X":
        arg = (Number.parseInt(`${arg}`, 10) >>> 0).toString(16).toUpperCase();
        break;
    }
    if (part.type === "j") {
      output += `${arg}`;
      continue;
    }
    let sign = "";
    if (numeric && (!positive || part.sign)) {
      sign = positive ? "+" : "-";
      arg = String(arg).replace(/^[+-]/, "");
    }
    const padCharacter = part.pad ? part.pad === "0" ? "0" : part.pad.charAt(1) : " ";
    const padLength = (part.width ?? 0) - `${sign}${arg}`.length;
    const pad = part.width && padLength > 0 ? padCharacter.repeat(padLength) : "";
    output += part.align ? `${sign}${arg}${pad}` : padCharacter === "0" ? `${sign}${pad}${arg}` : `${pad}${sign}${arg}`;
  }
  return output;
}
function sprintf(format, ...args) {
  return formatParts(parse(format), [format, ...args]);
}
function vsprintf(format, args) {
  return sprintf(format, ...args ?? []);
}
if (typeof window !== "undefined") Object.assign(window, { sprintf, vsprintf });
