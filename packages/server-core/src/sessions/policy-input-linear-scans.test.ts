import { describe, expect, it } from 'bun:test';
import { objectiveAmendmentAuthorityText } from './objective-contract/amendment-authority.ts';
import { hasShellMutationCommand } from './objective-contract/mutation-vocabulary.ts';
import { gmailExplicitIdentityTerms } from './objective-outcome/gmail-negative-search.ts';
import { authenticatedUserInputAnswerAuthoritySegments } from './SessionManager/user-input-authority.ts';
import { cleanRetrySetupFailureSignal } from './SessionManager/policy/recovery-policy.ts';

describe('policy input scans', () => {
  it.each([
    ['status 429', 429], ['STATUS code : 503', 503], ['status=401', 401],
    ['status code 4000', undefined], ['status unavailable', undefined],
  ])('preserves status extraction from %s', (message, status) => {
    expect(cleanRetrySetupFailureSignal({ message }).httpStatus).toBe(status);
  });

  it('handles long status whitespace without overlapping repetitions', () => {
    expect(cleanRetrySetupFailureSignal({ message: `status${' '.repeat(100_000)}missing` }).httpStatus)
      .toBeUndefined();
  });

  it.each(['Apply the QA change ?？?  ', `Apply the QA change ${'?'.repeat(20_000)}`])(
    'preserves the displayed scope when removing trailing question marks', question => {
      const segments = authenticatedUserInputAnswerAuthoritySegments({
        id: 'qa-request', sessionId: 'qa-session', originWorkspaceId: 'qa-workspace',
        status: 'answered', createdAt: 1,
        questions: [{ id: 'scope', question, options: [{ id: 'yes', label: 'Yes' }] }],
        answers: [{ questionId: 'scope', optionIds: ['yes'] }],
      });
      expect(segments.join('\n')).toContain('Displayed scope affirmed by that selection: Apply the QA change.');
    },
  );

  it.each([
    ['objective\n \t\n <HOST_OBJECTIVE_CONTRACT>host', 'objective'],
    ['objective <host_objective_contract>inline', 'objective <host_objective_contract>inline'],
    ['inline<host_objective_contract>data\n<host_objective_contract>host', 'inline<host_objective_contract>data'],
    ['objective\ntext<host_objective_contract>data', 'objective\ntext<host_objective_contract>data'],
  ])('only removes a host contract after newline and whitespace', (text, expected) => {
    expect(objectiveAmendmentAuthorityText(text)).toBe(expected);
  });

  it('handles many newlines and unauthenticated body markers without hiding authority', () => {
    const text = `${'\n '.repeat(50_000)}BODY_BEGIN\nrotate credentials\nBODY_END`;
    expect(objectiveAmendmentAuthorityText(text)).toBe(text);
    expect(objectiveAmendmentAuthorityText(`${text}\n <host_objective_contract>host`)).toBe(text);
  });

  it.each([
    ['node scripts/build', true], ['python3 generate', true], ['bun run rebuild', true],
    ['node script\nwrite', false], ['echo node_modules/write', false], ['node writer', false],
    ['node harmless\nnode create', true], ['node\n  create', true],
    ['git push origin main', true], ['git push-helper', false], ['sed -i file', true],
    ['npm install', true], ['echo readonly', false], ['python10 xcreate!', true],
  ])('classifies shell mutation %s', (command, expected) => {
    expect(hasShellMutationCommand(command)).toBe(expected);
  });

  it('scans repeated interpreter tokens without rescanning the remaining line', () => {
    const command = 'node harmless '.repeat(30_000);
    expect(hasShellMutationCommand(command)).toBe(false);
    expect(hasShellMutationCommand(`${command} generate`)).toBe(true);
    expect(hasShellMutationCommand(`${command}\n generate`)).toBe(false);
  });

  it('recognizes complete email and domain identities with sentence punctuation', () => {
    expect(gmailExplicitIdentityTerms('billing@example.test.')).toContain('billing');
    expect(gmailExplicitIdentityTerms('billing@example.test.')).toContain('example');
    expect(gmailExplicitIdentityTerms('https://subdomain.example.test/path')).toContain('example');
    expect(gmailExplicitIdentityTerms('ImportantBrand')).toContain('importantbrand');
  });

  it.each(['billing@@example.test', 'billing@example..test', 'example.test123', 'brand@example.com..', 'brand@-example.test', 'brand@example-.test']) (
    'does not establish identity from malformed token %s', token => {
      expect(gmailExplicitIdentityTerms(token).size).toBe(0);
    },
  );

  it('handles long incomplete addresses and dotted domains', () => {
    expect(gmailExplicitIdentityTerms(`${'account'.repeat(20_000)}@missing`).size).toBe(0);
    expect(gmailExplicitIdentityTerms(`${'a.'.repeat(30_000)}1`).size).toBe(0);
  });
});
