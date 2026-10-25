import { withScopeReview } from "./__fixtures__/scope-review.ts";
import { describe, expect, it } from "bun:test";
import type { Message, ObjectiveAcceptanceCriterion } from "@craft-agent/core/types";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { objectiveReviewBinding, transitionObjectiveContract } from "./objective-contract.ts";
import { collectObjectiveAcceptanceObservations, registerObjectiveAcceptanceCriteria, validateObjectiveAcceptanceCriteria } from "./objective-acceptance-criteria.ts";
import { validateObjectiveOutcome } from "./objective-outcome.ts";
import { criterion, objective, observation, receipt, root } from "./testing/objective-acceptance-criteria-fixture.ts";

describe('business criteria and durable goal — E01 E03 E04 E11 E12', () => {
  it('requires re-observation after an ambiguous tool or unproven shell command may change the target', () => {
    const possibleMutations: Message[] = [
      { ...observation, id: 'ambiguous', toolUseId: 'ambiguous', timestamp: 5,
        toolName: 'mcp__ops__get_and_process', toolInput: { host: 'dev', timer: 'cleanup' } },
      { ...observation, id: 'checkout', toolUseId: 'checkout', timestamp: 5,
        toolName: 'Bash', toolInput: { command: 'git checkout main' } },
      { ...observation, id: 'restart', toolUseId: 'restart', timestamp: 5,
        toolName: 'Bash', toolInput: { command: 'docker compose restart' } },
      { ...observation, id: 'find-write', toolUseId: 'find-write', timestamp: 5,
        toolName: 'Bash', toolInput: { command: 'find /srv/review -maxdepth 0 -fprintf /srv/review/state.txt changed' } },
      { ...observation, id: 'generic-action', toolUseId: 'generic-action', timestamp: 5,
        toolName: 'functions.exec', toolInput: { action: 'configure_service', host: 'dev', timer: 'cleanup' } },
      { ...observation, id: 'generic-sql', toolUseId: 'generic-sql', timestamp: 5,
        toolName: 'mcp__database__execute_query', toolInput: { query: 'SELECT mutate_timer()', host: 'dev', timer: 'cleanup' } },
      { ...observation, id: 'forward', toolUseId: 'forward', timestamp: 5,
        toolName: 'mcp__ops__forward_timer', toolInput: { host: 'dev', timer: 'cleanup' } },
    ];
    for (const possibleMutation of possibleMutations) {
      expect(validateObjectiveAcceptanceCriteria(
        objective, [root, observation, possibleMutation], receipt,
      )).toContain('Business criterion lacks matching post-action evidence: timer-active');
      const freshReceipt = { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
        ? { ...item, evidence: ['fresh'] }
        : item) };
      expect(validateObjectiveAcceptanceCriteria(
        objective, [root, observation, possibleMutation, { ...observation, id: 'fresh', toolUseId: 'fresh', timestamp: 6 }], freshReceipt,
      )).toEqual([]);
    }
  });

  it('requires registered checks for new actionable objectives and rechecks after partial failure', () => {
    const unregistered = transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 });
    expect(validateObjectiveAcceptanceCriteria(unregistered, [root, observation], receipt)).toHaveLength(1);
    const partial: Message = { ...observation, id: 'partial', toolUseId: 'partial', toolName: 'Edit', toolStatus: 'error', isError: true, toolResult: 'Wrote part of the file before failing' };
    expect(validateObjectiveAcceptanceCriteria(objective, [root, observation, partial], receipt)).toHaveLength(1);
  });

  it('binds independent review to the original goal and exact target/version criteria — E12', () => {
    const reviewedObjective = { ...objective, completionCriteria: [...objective.completionCriteria, 'independent-review-passed' as const] };
    const final = { ...receipt, criteria: [...receipt.criteria, { id: 'independent-review-passed', satisfied: true, evidence: ['review'] }] };
    const reviewed = { verdict: 'PASS', ...objectiveReviewBinding(reviewedObjective), findings: [],
      criteria: [...objective.completionCriteria, criterion.id].map(id => ({ id, passed: true })) };
    const sameConnectionReview: Message = { ...observation, id: 'review', toolUseId: 'review', toolName: 'mcp__llm__call_llm', timestamp: 6, toolResult: JSON.stringify(reviewed) };
    expect(validateObjectiveOutcome(final, {
      objective: reviewedObjective,
      messages: [root, observation, sameConnectionReview],
    }).valid).toBe(false);
    const review: Message = { ...sameConnectionReview, toolName: 'mcp__security__reviewer' };
    expect(validateObjectiveOutcome(final, { objective: reviewedObjective, messages: [root, observation, review] }).valid).toBe(true);
    for (const changed of [{ acceptanceSha256: 'old-version' }, { objectiveId: 'another-goal' }]) {
      expect(validateObjectiveOutcome(final, { objective: reviewedObjective, messages: [root, observation, { ...review, toolResult: JSON.stringify({ ...reviewed, ...changed }) }] }).valid).toBe(false);
    }
  });

  it('supports exact textual observations without accepting substring success claims', () => {
    const textCriterion = { ...criterion, checks: [{ path: '$text', equals: 'timer cleanup on dev: enabled, next run scheduled' }] };
    const textObjective = registerObjectiveAcceptanceCriteria(transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [textCriterion], 2);
    const textResult = { ...observation, toolResult: textCriterion.checks[0]!.equals };
    expect(validateObjectiveAcceptanceCriteria(textObjective, [root, textResult], receipt)).toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(textObjective, [root, { ...textResult, toolResult: `${textResult.toolResult} BUT FAILED` }], receipt)).toHaveLength(1);
  });

  it('ignores one final line terminator in exact text checks while retaining significant output', () => {
    for (const expected of ['{"ok":true}', '{"ok":true}\n', '{"ok":true}\r\n']) {
      const registered = registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
        [{ ...criterion, checks: [{ path: '$text', equals: expected }] }], 2,
      );
      const binding = objectiveReviewBinding(registered);
      for (const toolResult of ['{"ok":true}', '{"ok":true}\n', '{"ok":true}\r\n']) {
        expect(validateObjectiveAcceptanceCriteria(registered, [root, { ...observation, toolResult }], receipt)).toEqual([]);
      }
      for (const toolResult of [
        '{"ok":false}\n', '{"ok":true}\nERROR', ' {"ok":true}\n', '{"ok":true} \n',
        '{"ok":true}\n\n', '{"ok":true}\r\n\r\n', '{"ok":true}\r',
      ]) {
        expect(validateObjectiveAcceptanceCriteria(registered, [root, { ...observation, toolResult }], receipt)).toHaveLength(1);
      }
      expect(registered.acceptanceCriteria?.[0]?.checks[0]?.equals).toBe(expected);
      expect(objectiveReviewBinding(registered)).toEqual(binding);
    }
  });

  it('accepts a short exact response when the registered criterion binds the real call and target', () => {
    const textObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }),
      [{ ...criterion, checks: [{ path: '$text', equals: 'OK' }] }], 2,
    );
    const exactResult = { ...observation, toolResult: 'OK' };
    expect(validateObjectiveAcceptanceCriteria(textObjective, [root, exactResult], receipt)).toEqual([]);
    expect(validateObjectiveOutcome(receipt, { objective: textObjective, messages: withScopeReview(textObjective, [root, exactResult]) }).valid).toBe(true);
    for (const changed of [
      { toolInput: { host: 'production', timer: 'cleanup' } },
      { toolExecuted: false }, { toolStatus: 'error' as const }, { isError: true },
      { toolResult: 'OK but target differs' },
    ]) {
      expect(validateObjectiveAcceptanceCriteria(textObjective, [root, { ...exactResult, ...changed }], receipt)).toHaveLength(1);
      expect(validateObjectiveOutcome(receipt, { objective: textObjective, messages: withScopeReview(textObjective, [root, { ...exactResult, ...changed }]) }).valid).toBe(false);
    }
    const genericOnly = { ...textObjective, requiresAcceptanceCriteria: false, acceptanceCriteria: undefined };
    expect(validateObjectiveOutcome(receipt, { objective: genericOnly, messages: withScopeReview(genericOnly, [root, exactResult]) }).valid).toBe(false);
    expect(validateObjectiveOutcome({ ...receipt, criteria: receipt.criteria.map(item => (
      item.id === 'relevant-checks-passed' ? { ...item, evidence: [`tool:${criterion.toolName}`] } : item
    )) }, { objective: textObjective, messages: withScopeReview(textObjective, [root, exactResult]) }).valid).toBe(true);
    expect(validateObjectiveOutcome({ ...receipt, criteria: receipt.criteria.map(item => (
      item.id === criterion.id || item.id === 'relevant-checks-passed'
        ? { ...item, evidence: [`tool:${criterion.toolName}`] }
        : item
    )) }, { objective: textObjective, messages: withScopeReview(textObjective, [root, exactResult]) }).valid).toBe(true);
  });

  it('resolves persisted CRM and Gmail selectors without requiring a connector or data mutation', () => {
    const crmCriterion = { ...criterion, checks: [
      { path: '$.status', equals: 'open' }, { path: '$.step.id', equals: 17 },
    ] };
    const crmObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [crmCriterion], 2,
    );
    expect(validateObjectiveAcceptanceCriteria(JSON.parse(JSON.stringify(crmObjective)), [root, {
      ...observation, toolResult: '{"status":"open","step":{"id":17}}',
    }], receipt)).toEqual([]);

    const gmailCriterion = { ...criterion, checks: [
      { path: '$[0].subject', equals: 'Intervention — entité et lieu' },
      { path: '$[0].labelIds[0]', equals: 'SENT' },
    ] };
    const gmailObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: 'u1', text: root.content, nowMs: 1 }), [gmailCriterion], 2,
    );
    const sent = '[{"subject":"Intervention — entité et lieu","labelIds":["SENT"]}]';
    for (const toolResult of [sent, JSON.stringify({ content: [{ type: 'text', text: sent }] })]) {
      expect(validateObjectiveAcceptanceCriteria(gmailObjective, [root, { ...observation, toolResult }], receipt)).toEqual([]);
    }
    // Similar text, a different element and an object envelope are different facts.
    for (const toolResult of [
      sent.replace(' — entité', ' - entite'), sent.replace('SENT', 'DRAFT'),
      '[{}, {"subject":"Intervention — entité et lieu","labelIds":["SENT"]}]',
      JSON.stringify({ messages: JSON.parse(sent) }),
    ]) expect(validateObjectiveAcceptanceCriteria(gmailObjective, [root, { ...observation, toolResult }], receipt)).toHaveLength(1);
  });

  it('projects only the exact Gmail search summary into a bounded result count', () => {
    const searchCriterion: ObjectiveAcceptanceCriterion = {
      id: 'sent-reply-located', description: 'The exact sent reply is present.',
      toolName: 'mcp__google-contacts__gmail_search_exact',
      input: { query: 'in:sent subject:"Expected"', maxResults: 5 },
      checks: [{ path: '$.resultCount', equals: 1 }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [searchCriterion], 2,
    );
    const search: Message = { ...observation, toolName: searchCriterion.toolName,
      toolInput: { ...searchCriterion.input, _intent: 'Read-only verification.' },
      toolResult: '**Recherche Gmail API : « in:sent subject:"Expected" »**\n_1 message(s) retourné(s) ; lire le message exact avant toute action._\n\n### 1. Expected' };
    const claimed = { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
      ? { ...item, id: searchCriterion.id, evidence: ['t1'] }
      : item) };
    expect(validateObjectiveAcceptanceCriteria(registered, [root, search], claimed)).toEqual([]);
    expect(collectObjectiveAcceptanceObservations(registered, [root, search]))
      .toMatchObject([{ criterionId: searchCriterion.id, passed: true }]);
    const noneCriterion = { ...searchCriterion, checks: [{ path: '$.resultCount', equals: 0 }] };
    const noneObjective = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [noneCriterion], 2,
    );
    expect(validateObjectiveAcceptanceCriteria(noneObjective, [root, {
      ...search, toolResult: 'Aucun message Gmail trouvé pour : « in:sent subject:"Expected" »\n',
    }], claimed)).toEqual([]);
    for (const toolResult of [
      '**Recherche Gmail API : « in:sent subject:"Expected" »**\n_2 message(s) retourné(s) ; lire le message exact avant toute action._',
      'Résumé libre\n_1 message(s) retourné(s) ; lire le message exact avant toute action._',
      '**Recherche Gmail API : « in:sent subject:"Expected" »**\n_01 message(s) retourné(s) ; lire le message exact avant toute action._',
      '**Recherche Gmail API : « in:sent subject:"Expected" »**\n1 message retourné',
    ]) expect(validateObjectiveAcceptanceCriteria(registered, [root, { ...search, toolResult }], claimed)).toHaveLength(1);
  });

  it('uses host-retained Gmail metadata when media extraction replaces the original JSON', () => {
    const messageCriterion: ObjectiveAcceptanceCriterion = {
      id: 'sent-message', description: 'The sent message headers match.',
      toolName: 'mcp__google-contacts__gmail_get_message', input: { messageId: 'message-1' },
      checks: [
        { path: '$.to', equals: 'Recipient <recipient@example.com>' },
        { path: '$.from', equals: 'Sender <sender@example.com>' },
        { path: '$.subject', equals: 'Expected subject' },
        { path: '$.labelIds[0]', equals: 'SENT' },
      ],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [messageCriterion], 2,
    );
    const tempRoot = mkdtempSync(join(tmpdir(), 'gmail-media-'));
    try {
      const artifactDir = join(tempRoot, 'sessions', 'session-1', 'long_responses');
      mkdirSync(artifactDir, { recursive: true });
      const originalPath = join(artifactDir, 'message_original.json');
      const linkedPath = join(artifactDir, 'message_linked.json');
      const originalJson = '{"id":"message-1","subject":"Expected subject","from":"Sender <sender@example.com>","to":"Recipient <recipient@example.com>","labelIds":["SENT"],"bodyHtml":"data:image/png;base64,AAAA"}';
      writeFileSync(originalPath, originalJson);
      writeFileSync(linkedPath, '{}');
      const digest = createHash('sha256').update(originalJson).digest('hex');
      const metadata = '{"id":"message-1","subject":"Expected subject","from":"Sender <sender@example.com>","to":"Recipient <recipient@example.com>","labelIds":["SENT"]}';
      const extracted: Message = { ...observation, toolName: messageCriterion.toolName,
        toolInput: messageCriterion.input,
        toolResult: `[Structured media assets extracted and saved]\n\nResult metadata JSON: ${metadata}\n\nOriginal JSON SHA256: ${digest}\nOriginal JSON: ${originalPath}\nLinked JSON: ${linkedPath}\nAssets extracted: 1` };
      const claimed = { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
        ? { ...item, id: messageCriterion.id, evidence: ['t1'] }
        : item) };
      expect(validateObjectiveAcceptanceCriteria(registered, [root, extracted], claimed, 'session-1')).toEqual([]);
      for (const changed of [
        { toolName: 'mcp__other__gmail_get_message' },
        { toolExecuted: undefined },
        { toolResult: `Prose\n${extracted.toolResult}` },
        { toolResult: extracted.toolResult!.replace(metadata, '{"to":"Recipient <recipient@example.com>","from":"Sender <sender@example.com>","subject":"Expected subject","labelIds":["SENT"],"bodyHtml":"forged"}') },
        { toolResult: extracted.toolResult!.replace(digest, '0'.repeat(64)) },
        { toolResult: extracted.toolResult!.replace(originalPath, join(artifactDir, 'missing.json')) },
      ]) expect(validateObjectiveAcceptanceCriteria(
        registered, [root, { ...extracted, ...changed }], claimed, 'session-1',
      )).toHaveLength(1);
      expect(validateObjectiveAcceptanceCriteria(registered, [root, extracted], claimed, 'foreign-session'))
        .toHaveLength(1);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('projects only an exact WebFetch JSON wrapper bound to the requested URL', () => {
    const webCriterion: ObjectiveAcceptanceCriterion = {
      id: 'vendor-ready', description: 'The vendor endpoint reports ready.',
      toolName: 'WebFetch', input: { url: 'http://example.com/status' },
      checks: [{ path: '$.status', equals: 'ready' }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [webCriterion], 2,
    );
    const fetched: Message = { ...observation, toolName: 'WebFetch', toolInput: webCriterion.input,
      toolResult: 'JSON from https://example.com/status/:\n\n{"status":"ready"}' };
    const claimed = { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
      ? { ...item, id: webCriterion.id, evidence: ['t1'] } : item) };
    expect(validateObjectiveAcceptanceCriteria(registered, [root, fetched], claimed)).toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(registered, [root, {
      ...fetched, toolResult: 'JSON from https://example.com/status:\n\n{"status":"ready"}',
    }], claimed)).toEqual([]);
    for (const toolResult of [
      'JSON from https://other.example/status/:\n\n{"status":"ready"}',
      'JSON from https://example.com/other:\n\n{"status":"ready"}',
      'JSON from https://example.com/status//:\n\n{"status":"ready"}',
      'JSON from https://example.com/status///:\n\n{"status":"ready"}',
      'JSON from https://example.com/status////evil/../:\n\n{"status":"ready"}',
      'Report\nJSON from https://example.com/status/:\n\n{"status":"ready"}',
      'JSON from https://example.com/status/:\n\nnot-json',
    ]) expect(validateObjectiveAcceptanceCriteria(registered, [root, { ...fetched, toolResult }], claimed)).toHaveLength(1);
  });

  it('projects successful native Bash transport for text or HTML curl output', () => {
    const bashCriterion: ObjectiveAcceptanceCriterion = {
      id: 'public-health', description: 'The public health request exits zero.', toolName: 'Bash',
      input: { command: 'curl --fail --silent https://example.com/health' },
      checks: [{ path: '$.transport.success', equals: true }, { path: '$.transport.code', equals: 0 }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [bashCriterion], 2,
    );
    const response: Message = { ...observation, toolName: 'Bash', toolInput: bashCriterion.input,
      toolResult: '<html><body>healthy</body></html>' };
    const claimed = { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
      ? { ...item, id: bashCriterion.id, evidence: ['t1'] } : item) };
    expect(validateObjectiveAcceptanceCriteria(registered, [root, response], claimed)).toEqual([]);
    for (const changes of [{ toolExecuted: false }, { toolStatus: 'error' as const, isError: true }]) {
      expect(validateObjectiveAcceptanceCriteria(registered, [root, { ...response, ...changes }], claimed)).toHaveLength(1);
    }
    expect(validateObjectiveAcceptanceCriteria(registered, [root, {
      ...response, toolResult: '{"status":"ready"}',
    }], claimed)).toEqual([]);
    expect(validateObjectiveAcceptanceCriteria(registered, [root, {
      ...response, toolResult: '"ready"',
    }], claimed)).toEqual([]);
    for (const toolResult of ['{}', 'true', 'null']) {
      expect(validateObjectiveAcceptanceCriteria(registered, [root, {
        ...response, toolExecuted: undefined, toolResult,
      }], claimed)).toHaveLength(1);
    }

    const curlWithoutFail = {
      ...bashCriterion,
      id: 'public-transport-only',
      input: { command: 'curl --silent https://example.com/health' },
    };
    const transportOnly = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      [{ ...curlWithoutFail, checks: [{ path: '$.transport.code', equals: 0 }] }], 2,
    );
    const errorPage: Message = { ...response, toolInput: curlWithoutFail.input, toolResult: '<html>404</html>' };
    expect(validateObjectiveAcceptanceCriteria(transportOnly, [root, errorPage], {
      ...receipt, criteria: [{ id: curlWithoutFail.id, satisfied: true, evidence: ['t1'] }],
    })).toEqual([]);
    expect(() => registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }),
      [curlWithoutFail], 2, undefined, [root, errorPage],
    )).toThrow('unsupported shell transport predicate');

    for (const command of [
      'test -e /tmp/report.json',
      'cmp -s /tmp/report.json /tmp/expected.json',
      'curl --fail --silent -o /dev/null https://example.com/health',
    ]) {
      const emptyCriterion = { ...bashCriterion, id: `empty-${command.split(/\s+/, 1)[0]}`,
        input: { command }, checks: [{ path: '$.transport.code', equals: 0 }] };
      const emptyObjective = registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [emptyCriterion], 2,
      );
      const emptyResult = { ...response, toolInput: emptyCriterion.input, toolResult: '' };
      expect(validateObjectiveAcceptanceCriteria(emptyObjective, [root, emptyResult], {
        ...receipt, criteria: [{ id: emptyCriterion.id, satisfied: true, evidence: ['t1'] }],
      })).toEqual([]);
    }
  });

  it('uses only bounded host-retained metadata from a spilled exact result', () => {
    const metadataCriterion: ObjectiveAcceptanceCriterion = {
      id: 'release-validator', description: 'The release status check succeeds.', toolName: 'mcp__ops__get_status',
      input: { host: 'staging' }, checks: [{ path: '$.success', equals: true }, { path: '$.code', equals: 0 }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [metadataCriterion], 2,
    );
    const tempRoot = mkdtempSync(join(tmpdir(), 'acceptance-spill-'));
    try {
      const spillDir = join(tempRoot, 'sessions', 'session-1', 'long_responses');
      mkdirSync(spillDir, { recursive: true });
      const filePath = join(spillDir, 'result.txt');
      const fullText = '{"code":0,"success":true,"payload":"retained only on disk"}';
      writeFileSync(filePath, fullText);
      const digest = createHash('sha256').update(fullText).digest('hex');
      const result: Message = { ...observation, toolName: metadataCriterion.toolName, toolInput: metadataCriterion.input,
        toolResult: `[Large response (~9000 tokens) summarized]\n\nResult metadata JSON: {"code":0,"success":true}\n\nFull data SHA256: ${digest}\n\nFull data saved to: ${filePath}\n- Use Read/Grep to access specific content\n- Use transform_data with inputFiles: ["long_responses/result.txt"] for data analysis\n\nsummary` };
      const claimed = { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
        ? { ...item, id: metadataCriterion.id, evidence: ['t1'] } : item) };
      expect(validateObjectiveAcceptanceCriteria(registered, [root, result], claimed, 'session-1')).toEqual([]);
      for (const toolResult of [
        result.toolResult!.replace('{"code":0,"success":true}', '{"code":0,"success":false}'),
        `Prose before\n${result.toolResult}`,
        result.toolResult!.replace('Full data saved to: ', 'Data saved to: '),
        result.toolResult!.replace(digest, '0'.repeat(64)),
        result.toolResult!.replace(filePath, join(spillDir, 'missing.txt')),
      ]) expect(validateObjectiveAcceptanceCriteria(
        registered, [root, { ...result, toolResult }], claimed, 'session-1',
      )).toHaveLength(1);
      expect(validateObjectiveAcceptanceCriteria(registered, [root, result], claimed, 'foreign-session'))
        .toHaveLength(1);
      expect(validateObjectiveAcceptanceCriteria(registered, [root, {
        ...result, timestamp: Date.now() + 5_000,
      }], claimed, 'session-1')).toHaveLength(1);

      const webFullText = `JSON from https://example.com/status/:\n\n${JSON.stringify({ status: 'ready', payload: 'x'.repeat(20_000) })}`;
      const webPath = join(spillDir, 'web-fetch.txt');
      writeFileSync(webPath, webFullText);
      const webDigest = createHash('sha256').update(webFullText).digest('hex');
      const webCriterion: ObjectiveAcceptanceCriterion = {
        id: 'large-web-status', description: 'Large redirected vendor result is ready.', toolName: 'WebFetch',
        input: { url: 'http://example.com/status' }, checks: [{ path: '$.status', equals: 'ready' }],
      };
      const webObjective = registerObjectiveAcceptanceCriteria(
        transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [webCriterion], 2,
      );
      const webResult = { ...observation, toolName: 'WebFetch', toolInput: webCriterion.input,
        toolResult: `[Response too large (~9000 tokens)]\n\nResult metadata JSON: {"status":"ready"}\n\nFull data SHA256: ${webDigest}\n\nFull data saved to: ${webPath}\n- Use Read/Grep to access specific content\n- Use transform_data with inputFiles: ["long_responses/web-fetch.txt"] for data analysis\n\nPreview:\n...` };
      expect(validateObjectiveAcceptanceCriteria(webObjective, [root, webResult], {
        ...receipt, criteria: [{ id: webCriterion.id, satisfied: true, evidence: ['t1'] }],
      }, 'session-1')).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('projects a real canonical browser navigation, but not a challenge or embedded claim', () => {
    const browserCriterion: ObjectiveAcceptanceCriterion = {
      id: 'public-route', description: 'The public route is reachable.',
      toolName: 'mcp__session__browser_tool', input: { command: 'navigate https://orion.example' },
      checks: [{ path: '$.success', equals: true }, { path: '$.url', equals: 'https://orion.example/requests' }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [browserCriterion], 2,
    );
    const navigation: Message = { ...observation, toolName: browserCriterion.toolName,
      toolInput: browserCriterion.input,
      toolResult: 'Navigated to: https://orion.example/requests\nTitle: Orion\nElapsed: 307ms' };
    const claimed = { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
      ? { ...item, id: browserCriterion.id, evidence: ['t1'] }
      : item) };
    expect(validateObjectiveAcceptanceCriteria(registered, [root, navigation], claimed)).toEqual([]);
    expect(collectObjectiveAcceptanceObservations(registered, [root, navigation]))
      .toMatchObject([{ criterionId: browserCriterion.id, passed: true }]);
    for (const toolResult of [
      'Security verification detected (cloudflare).\nURL: https://orion.example/',
      'Status report\nNavigated to: https://orion.example/requests',
      'Navigated to: javascript:alert(1)',
      ' Navigated to: https://orion.example/requests',
    ]) expect(validateObjectiveAcceptanceCriteria(registered, [root, { ...navigation, toolResult }], claimed)).toHaveLength(1);
  });

  it('projects exit zero only for an explicitly executed first-party OSS healthcheck', () => {
    const healthCriterion: ObjectiveAcceptanceCriterion = {
      id: 'oss-health', description: 'The OSS healthcheck exits successfully.',
      toolName: 'mcp__rbw-agents-oss__oss_healthcheck', input: { _displayName: 'Contrôler santé' },
      checks: [{ path: '$.success', equals: true }, { path: '$.code', equals: 0 }],
    };
    const registered = registerObjectiveAcceptanceCriteria(
      transitionObjectiveContract({ messageId: root.id, text: root.content, nowMs: 1 }), [healthCriterion], 2,
    );
    const health: Message = { ...observation, toolName: healthCriterion.toolName,
      toolInput: healthCriterion.input,
      toolResult: '== docker compose ps ==\nservices healthy\n{"ok":true,"status":"passed"}' };
    const claimed = { ...receipt, criteria: receipt.criteria.map(item => item.id === criterion.id
      ? { ...item, id: healthCriterion.id, evidence: ['t1'] }
      : item) };
    expect(validateObjectiveAcceptanceCriteria(registered, [root, health], claimed)).toEqual([]);
    expect(collectObjectiveAcceptanceObservations(registered, [root, health]))
      .toMatchObject([{ criterionId: healthCriterion.id, passed: true }]);
    for (const changed of [
      { toolName: 'mcp__other__oss_healthcheck' },
      { toolExecuted: undefined },
      { toolResult: '' },
      { toolResult: '{"success":false,"code":1}' },
    ]) expect(validateObjectiveAcceptanceCriteria(registered, [root, { ...health, ...changed }], claimed)).toHaveLength(1);
  });
});
