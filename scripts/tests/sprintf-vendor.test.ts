import { describe, expect, test } from 'bun:test'
import * as source from '../vendor/sprintf-js/src/sprintf.ts'
import * as generated from '../vendor/sprintf-js/src/sprintf.js'
const cases: Array<[string, unknown[], string]> = [
  ['%s %s', ['hello', 'world'], 'hello world'],
  ['%2$s %1$s', ['one', 'two'], 'two one'],
  ['%(users[0].name)s', [{ users: [{ name: 'Ada' }] }], 'Ada'],
  ['%+05d', [42], '+0042'], ['%-5s', ['x'], 'x    '],
  ["%'_5s", ['x'], '____x'], ['%.2f', [1.234], '1.23'],
  ['%.2g', [12.345], '12'], ['%.2e', [12.345], '1.23e+1'],
  ['%b %o %x %X', [10, 10, 255, 255], '1010 12 ff FF'],
  ['%t %T %v', [0, [], new String('value')], 'false array value'],
  ['%s', [() => 'called'], 'called'], ['%j', [{ a: 1 }], '{"a":1}'],
  ['%% %c %u', [65, -1], '% A 4294967295'],
]
for (const [name, module] of [['source', source], ['generated', generated]] as const) {
  describe(`sprintf ${name}`, () => {
    test.each(cases)('%s preserves the formatting contract', (format, args, result) => {
      expect(module.sprintf(format, ...args)).toBe(result)
      expect(module.vsprintf(format, args)).toBe(result)
    })
    test('retains allocation bounds and rejects incompatible coercions', () => {
      expect(module.sprintf('%1024s', 'x')).toHaveLength(1024)
      for (const format of ['%1025s', '%.1025s', '%.101f']) {
        expect(() => module.sprintf(format, 1)).toThrow(RangeError)
      }
      expect(() => module.sprintf('%d', 5n)).toThrow(TypeError)
      expect(() => module.sprintf('%o', Symbol('value'))).toThrow(TypeError)
      expect(() => module.sprintf('%s %(name)s', { name: 'Ada' })).toThrow()
      expect(() => module.sprintf('%(missing.name)s', {})).toThrow()
    })
    test('remains correct across the bounded parse cache rollover', () => {
      for (let index = 0; index < 1100; index++) {
        expect(module.sprintf(`item ${index}: %s`, 'ok')).toBe(`item ${index}: ok`)
      }
      expect(module.vsprintf('plain', null)).toBe('plain')
    })
  })
}
