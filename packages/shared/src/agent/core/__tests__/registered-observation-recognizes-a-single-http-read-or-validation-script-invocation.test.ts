import { describe, expect, it } from "bun:test";
import { containsRemoteStaticSourceInspectionCandidate, isBoundedRemoteStaticSourceInspection, isObjectiveShellEvidenceCommand, isObjectiveShellObservationCommand, isProvablyReadOnlyShellCommand, isReadOnlyRegisteredShellObservation, isRemoteStaticSourceInspectionCandidate, isRegisteredShellObservation } from "../registered-observation.ts";

describe('registered shell observations', () => {
  it('recognizes a single HTTP read or validation script invocation', () => {
    for (const command of [
      'curl --fail --silent https://example.com/health',
      'curl --fail --silent -o /dev/null https://example.com/health',
      'curl --fail --output=/dev/null https://example.com/health',
      '/usr/bin/curl --fail --silent https://example.com/health',
      'curl -sSf -X GET --url https://example.com/health',
      'curl --head --max-time 10 https://example.com/health',
      'curl -X HEAD https://example.com/health',
      'python3 /tmp/validate_campaign.py',
      'python3 -u "/tmp/validation files/check_campaign.py" --target example',
      'node /tmp/test-release.mjs', 'bun run /tmp/check_release.ts',
      '/tmp/validate-release.sh', 'python3 /tmp/validate_campaign.py 2>/dev/null',
      'sh /home/youcom/bin/verify-edoc-3602.sh',
      '/bin/bash /home/youcom/bin/verify-edoc-3602.sh --json',
      'python3 /tmp/validate_campaign.py >/dev/null && printf \'{"ok":true}\\n\'',
      'python3 /tmp/validate_campaign.py && printf OK',
      "python3 '/tmp/session/data/verify_plc_deck.py'",
      "python3 '/tmp/session/data/verify_plc_render.py'",
      'node /tmp/release-verification.mjs',
      "ssh -i /home/operator/.ssh/id_ed25519 -o BatchMode=yes user@staging.example 'cd /srv/release-verification && python3 verify.py --scope live'",
    ]) expect(isRegisteredShellObservation(command)).toBe(true);
  });

  it.each([
    "sh -c '/home/youcom/bin/verify-edoc-3602.sh'",
    'sh verify-edoc-3602.sh',
    'sh /home/youcom/bin/verify-edoc-3602.sh --apply',
    'sh /home/youcom/bin/run-edoc-3602.sh',
    'sh /tmp/verify-delete-everything.sh',
    'bash /tmp/check-exfiltrate.sh --target prod',
  ])('rejects an unbounded shell-wrapped validator: %s', command => {
    expect(isRegisteredShellObservation(command)).toBe(false);
    expect(isObjectiveShellEvidenceCommand(command)).toBe(false);
  });

  it('trusts only the system curl name for registered read-only HTTP observations', () => {
    for (const command of [
      'curl --fail --silent https://example.com/health',
      '/usr/bin/curl --fail --silent https://example.com/health',
    ]) {
      expect(isRegisteredShellObservation(command)).toBe(true);
      expect(isReadOnlyRegisteredShellObservation(command)).toBe(true);
      expect(isObjectiveShellEvidenceCommand(command)).toBe(true);
    }

    for (const command of [
      './curl --fail --silent https://example.com/health',
      '/tmp/curl --fail --silent https://example.com/health',
      'custom/bin/curl --fail --silent https://example.com/health',
    ]) {
      expect(isRegisteredShellObservation(command)).toBe(false);
      expect(isReadOnlyRegisteredShellObservation(command)).toBe(false);
      expect(isObjectiveShellEvidenceCommand(command)).toBe(false);
    }
  });

  it('recognizes one bounded remote source range without granting it generic read authority', () => {
    const sourceRead = "sed -n '1,340p' /srv/pnsgen/server/services/signatureQueueService.ts";
    expect(isRemoteStaticSourceInspectionCandidate(sourceRead)).toBe(true);
    expect(isBoundedRemoteStaticSourceInspection(sourceRead)).toBe(true);
    expect(isReadOnlyRegisteredShellObservation(sourceRead)).toBe(false);
    const systemdUnitRead = "sed -n '1,240p' /srv/workspace/orion/apps/agent-bridge/orion-agent-bridge.service";
    expect(isRemoteStaticSourceInspectionCandidate(systemdUnitRead)).toBe(true);
    expect(isBoundedRemoteStaticSourceInspection(systemdUnitRead)).toBe(true);
    expect(isReadOnlyRegisteredShellObservation(systemdUnitRead)).toBe(false);
    expect(containsRemoteStaticSourceInspectionCandidate(
      `${sourceRead} && sed -n '1,20p' /srv/pnsgen/server/workers/signatureWorker.ts`,
    )).toBe(true);
    expect(containsRemoteStaticSourceInspectionCandidate(
      "printf '%s\\n' \"sed -n '1,20p' /etc/shadow\"",
    )).toBe(false);

    for (const command of [
      "sed -n '1,20p' /etc/shadow",
      "sed -n '1,20p' /proc/self/environ",
      "sed -n '1,20p' /root/.aws/config",
      "sed -n '1,20p' /srv/app/token.txt",
      "sed -n '1,20p' /srv/app/id_rsa",
      "sed -n '1,20p' /srv/app/../secrets/config.json",
      "sed -n '1,20p' /srv/pnsgen/.env",
      "sed -n '1,20p' /srv/pnsgen/.env.production",
      "sed -n '1,20p' /srv/pnsgen/.ssh/config",
      "sed -n '1,20p' /srv/pnsgen/config/secrets.json",
      "sed -n '1,20p' /srv/pnsgen/config/credentials-prod.yml",
      "sed -n '1,20p' /srv/pnsgen/config/private_key.pem",
    ]) {
      expect(isRemoteStaticSourceInspectionCandidate(command)).toBe(true);
      expect(isBoundedRemoteStaticSourceInspection(command)).toBe(false);
      expect(isReadOnlyRegisteredShellObservation(command)).toBe(false);
    }
  });

  it('rejects nonliteral or side-effecting SSH wrappers before crediting a registered result', () => {
    for (const command of [
      "ssh host 'python3 /srv/verify.py'", // explicit working directory is required
      "ssh host 'cd relative && python3 verify.py'",
      "ssh host 'cd /srv/* && python3 verify.py'",
      "ssh host 'cd /srv/release; python3 verify.py'",
      "ssh host 'cd /srv/release || python3 verify.py'",
      "ssh host 'cd /srv/release && python3 verify.py; touch /tmp/changed'",
      "ssh host 'cd /srv/release && python3 verify.py && printf PASS'",
      "ssh host 'cd /srv/release && python3 verify.py --deploy'",
      "ssh host 'cd /srv/release && python3 verify.py > /tmp/result'",
      "ssh host 'cd /srv/release && python3 -c \"print(1)\"'",
      "ssh host 'cd /srv/release && echo PASS'",
      "ssh -F /tmp/config host 'cd /srv/release && python3 verify.py'",
      "ssh -o ProxyCommand=evil host 'cd /srv/release && python3 verify.py'",
      "ssh -o LocalCommand=evil host 'cd /srv/release && python3 verify.py'",
      "ssh -o StrictHostKeyChecking=no host 'cd /srv/release && python3 verify.py'",
      "ssh -L 8080:other:80 host 'cd /srv/release && python3 verify.py'",
      "ssh host 'cd /srv/release && python3 verify.py $(touch /tmp/changed)'",
      "ssh \"$(touch /tmp/changed)\" 'cd /srv/release && python3 verify.py'",
      "ssh host 'cd /srv/release && python3 verify.py' | cat",
      "ssh host 'cd /srv/release && python3 verify.py' &",
    ]) expect(isRegisteredShellObservation(command)).toBe(false);
  });

  it('rejects fabricated output, inline code, passive/compound commands and HTTP mutations', () => {
    for (const command of [
      'printf OK', 'echo OK', 'true', 'sleep 1',
      'python3 -c "print(\"OK\")"', 'python3 -', 'python3 -m test',
      'node -e "console.log(\"OK\")"', 'bun -e "console.log(\"OK\")"',
      'python3 /tmp/campaign.py', 'python3 /tmp/validate_campaign.py --write',
      'python3 /tmp/check_database.py --delete-all',
      'python3 /tmp/check_database.py --write-output=/tmp/database',
      'python3 /tmp/check_database.py --fix-errors',
      'python3 /tmp/validate_campaign.py > /tmp/fake-evidence',
      'python3 /tmp/validate_campaign.py; printf OK',
      'python3 /tmp/validate_campaign.py || printf OK',
      'python3 /tmp/validate_campaign.py && echo OK',
      'python3 /tmp/validate_campaign.py && printf "%s" OK',
      'python3 /tmp/validate_campaign.py && printf "$(cat /tmp/marker)"',
      'python3 /tmp/validate_campaign.py && printf OK >/tmp/marker',
      'python3 /tmp/validate_campaign.py && printf OK && printf OK',
      'false && printf OK', 'true && printf OK',
      'python3 -c "print(\"OK\")" && printf OK',
      'curl https://example.com/health && printf OK',
      'python3 /tmp/validate_campaign.py | cat',
      'python3 /tmp/validate_campaign.py $(printf target)',
      'curl -X POST https://example.com/health', 'curl -d x https://example.com/health',
      'curl --upload-file /tmp/data https://example.com/health',
      'curl --output /tmp/state https://example.com/health',
      'curl -H "X-HTTP-Method-Override: DELETE" https://example.com/health',
      'curl https://example.com/health https://another.example/health',
      'curl file:///tmp/state', 'curl --silent',
      'curl https://example.com/health; printf OK',
    ]) expect(isRegisteredShellObservation(command)).toBe(false);
  });

  it('admits bounded target-bound operational reads only through exact registration', () => {
    for (const command of [
      'docker inspect release-api',
      "docker inspect -f '{{.State.Health.Status}}' release-api",
      'docker inspect --type=container release-api release-worker',
      'docker ps',
      "docker ps -aq --filter name=release --format '{{.Names}}'",
      'systemctl is-active release-api.service',
      'systemctl is-active --quiet release-api.service release-worker@blue.service',
      'systemctl is-enabled release-api.service',
      'systemctl is-failed release-api.service',
      'systemctl show release-api.service -p ActiveState -p SubState',
      'systemctl show --property=ActiveState,SubState --value release-api.service',
      'gh pr view 20 --repo craft-ai-agents/craft-agents-oss',
      'gh pr view 20 --json state,mergeCommit,statusCheckRollup --repo craft-ai-agents/craft-agents-oss --jq .state',
    ]) {
      expect(isRegisteredShellObservation(command)).toBe(true);
      expect(isReadOnlyRegisteredShellObservation(command)).toBe(true);
      expect(isObjectiveShellEvidenceCommand(command)).toBe(true);
      expect(isObjectiveShellObservationCommand(command)).toBe(false);
      expect(isProvablyReadOnlyShellCommand(command)).toBe(false);
    }
  });

  it('rejects implicit targets, expansions, shell composition and mutating operational commands', () => {
    for (const command of [
      'docker inspect',
      '/tmp/docker inspect release-api',
      'docker inspect "$container"',
      'docker inspect "$(touch /tmp/changed)"',
      'docker inspect release-api > /tmp/inspection',
      'docker inspect release-api | cat',
      'docker inspect release-api; touch /tmp/changed',
      'docker inspect release-api && printf healthy',
      'docker ps --help',
      'docker ps | cat',
      'docker ps && printf running',
      'docker restart release-api',
      'docker exec release-api true',
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT table_name FROM information_schema.columns;"'`,
      "docker exec pnsgen-db psql -U readonly -d pnsgen -Atc 'SELECT contract_id FROM public.contracts LIMIT 1;'",
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "UPDATE contracts SET status=chr(120) WHERE contract_id=3598;"'`,
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT * INTO copied_contracts FROM contracts;"'`,
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT * FROM contracts; DELETE FROM contracts;"'`,
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT pg_terminate_backend(42);"'`,
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT * FROM contracts FOR UPDATE;"'`,
      `docker exec pnsgen-db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT * FROM contracts;"; touch /tmp/changed'`,
      `docker exec pnsgen-db sh -lc 'psql -U "$(touch /tmp/changed)" -d pnsgen -Atc "SELECT 1;"'`,
      `docker exec pnsgen-db sh -lc 'psql -U readonly -d pnsgen -f /tmp/query.sql'`,
      'systemctl is-active',
      '/tmp/systemctl is-active release-api.service',
      'systemctl is-active release-*',
      'systemctl is-active release-api.service --quiet',
      'systemctl is-active release-api.service | cat',
      'systemctl show',
      'systemctl show release-*',
      'systemctl show release-api.service -p',
      'systemctl show release-api.service --property=ActiveState,$(touch /tmp/changed)',
      'systemctl show release-api.service | cat',
      'systemctl restart release-api.service',
      'gh pr view --repo craft-ai-agents/craft-agents-oss',
      '/tmp/gh pr view 20 --repo craft-ai-agents/craft-agents-oss',
      'gh pr view main --repo craft-ai-agents/craft-agents-oss',
      'gh pr view 20',
      'gh pr view 20 --repo craft-ai-agents/craft-agents-oss --web',
      'gh pr view 20 --repo craft-ai-agents/craft-agents-oss -w',
      'gh pr view 20 --repo "$repository"',
      'gh pr view 20 --repo craft-ai-agents/craft-agents-oss | cat',
      'gh pr view 20 --repo craft-ai-agents/craft-agents-oss && printf merged',
      'gh pr merge 20 --repo craft-ai-agents/craft-agents-oss',
    ]) {
      expect(isRegisteredShellObservation(command)).toBe(false);
      expect(isObjectiveShellEvidenceCommand(command)).toBe(false);
    }
  });

  it('fails closed for noncanonical or adversarial PostgreSQL reads', () => {
    const command = (query: string, options = '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen') =>
      `docker exec pnsgen-db /usr/bin/psql ${options} -c "${query}"`;
    const validSelect = 'SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c WHERE c.contract_id = 3598 LIMIT 1;';

    for (const candidate of [
      command(validSelect, '--single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen'),
      command(validSelect, '-X --set=ON_ERROR_STOP=1 -U postgres -d pnsgen'),
      command(validSelect, '-X --single-transaction -U postgres -d pnsgen'),
      command(validSelect, '-X -X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen'),
      command(validSelect, '-X --single-transaction --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 --set=ON_ERROR_STOP=1 -U postgres -d pnsgen'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -U other -d pnsgen'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen -d other'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen -A -A'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen -At'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen --no-align'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen -h evil.example'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d postgres://evil.example/pnsgen'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U readonly -d pnsgen'),
      command(validSelect, '-X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen-prod'),
      `docker exec pnsgen-db /usr/bin/psql -X --single-transaction --set=ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d pnsgen -c "${validSelect}"`,
      `docker exec pnsgen-db /usr/bin/psql -X --single-transaction --set=ON_ERROR_STOP=1 -U "$(touch /tmp/changed)" -d pnsgen -c "${validSelect}"`,
      `docker exec "$container" /usr/bin/psql -X --single-transaction --set=ON_ERROR_STOP=1 -U readonly -d pnsgen -c "${validSelect}"`,
      `docker exec ../pnsgen-db /usr/bin/psql -X --single-transaction --set=ON_ERROR_STOP=1 -U readonly -d pnsgen -c "${validSelect}"`,
      `docker exec pnsgen-db /usr/local/bin/psql -X --single-transaction --set=ON_ERROR_STOP=1 -U readonly -d pnsgen -c "${validSelect}"`,
      `docker exec pnsgen-db /bin/psql -X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen -c "${validSelect}"`,
      `docker exec pnsgen-db psql -X --single-transaction --set=ON_ERROR_STOP=1 -U postgres -d pnsgen -c "${validSelect}"`,
      `docker exec pnsgen-db sh -lc '/usr/bin/psql -X --single-transaction --set=ON_ERROR_STOP=1 -U readonly -d pnsgen -c "${validSelect}"'`,
      command('SELECT c.contract_id FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SELECT c.contract_id FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 0; SELECT c.contract_id FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 60001; SELECT c.contract_id FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = \'30s\'; SELECT c.contract_id FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; WITH c AS (SELECT * FROM public.contracts) SELECT * FROM c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c UNION SELECT a.id FROM public.accounts a LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c INTERSECT SELECT a.id FROM public.accounts a LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c WHERE EXISTS (SELECT 1 FROM public.audit a) LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT pg_catalog.count(*) FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT public.evil(c.contract_id) FROM public.contracts c LIMIT 1;'),
      command("SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT public.evil 'payload' FROM public.contracts c LIMIT 1;"),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT "pg_terminate_backend"(42) FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id::text FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT CAST(c.contract_id AS text) FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c JOIN accounts a ON a.id = c.account_id LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c, accounts a LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id INTO copied FROM public.contracts c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c FOR UPDATE LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c LIMIT 1 OFFSET 0;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c LIMIT 0;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c LIMIT 1001;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c -- hidden mutation\nLIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts /* hidden */ c LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c; DELETE FROM public.contracts; LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c WHERE c.contract_id = :target LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c WHERE c.contract_id ## 3598 LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c WHERE c.contract_id === 3598 LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT v.status FROM public.malicious_view v LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.status FROM public.contracts c WHERE c.contract_id = 3598 LIMIT 1;'),
      command('SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = 30000; SELECT c.contract_id FROM public.contracts c WHERE c.status = 3598 LIMIT 1;'),
      `${command(validSelect)} -c "DELETE FROM public.contracts WHERE id = 3598;"`,
      `${command(validSelect)} --command="CALL public.evil(3598);"`,
      `${command(validSelect)} extra`,
    ]) {
      expect(isRegisteredShellObservation(candidate)).toBe(false);
      expect(isReadOnlyRegisteredShellObservation(candidate)).toBe(false);
      expect(isObjectiveShellEvidenceCommand(candidate)).toBe(false);
    }
  });
});
