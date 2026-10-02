import ast, copy, hashlib, importlib.util, json, os, stat, subprocess, sys, tempfile, types, unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import traid_shadow_release_provenance as p

class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.repo = self.base / 'repo'; self.repo.mkdir()
        def git(*argv):
            return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-C', str(self.repo), *argv], stderr=subprocess.DEVNULL, text=True).strip()
        git('init'); (self.repo / 'source.py').write_text('safe observer fixture\n')
        git('add', 'source.py'); git('commit', '-m', 'fixture')
        self.sha = git('rev-parse', 'HEAD'); self.tree = git('rev-parse', 'HEAD^{tree}')
        self.releases = self.base / 'releases'; self.releases.mkdir()
        self.current = self.releases / self.sha
        git('worktree', 'add', '--detach', str(self.current), self.sha)
        entries=[]
        for file in sorted([self.current, *self.current.rglob('*')], key=lambda q:q.relative_to(self.current).as_posix()):
            file.chmod(0o555 if file.is_dir() else 0o444); s=file.stat()
            e={'path':file.relative_to(self.current).as_posix(),'kind':'directory' if file.is_dir() else 'file','mode':oct(stat.S_IMODE(s.st_mode)),'uid':s.st_uid,'gid':s.st_gid}
            if file.is_file():e.update(size=s.st_size,sha256=hashlib.sha256(file.read_bytes()).hexdigest())
            entries.append(e)
        self.registry = self.base / 'registry'; self.registry.mkdir(mode=0o755)
        self.manifest={'schema':'traid.onchain-release-content-manifest.v3','release_sha':self.sha,'release_path':str(self.current),'git_tree':self.tree,'owner_policy':'ubuntu_owned_static_runtime_read_only_release_v1','runtime_check':'TRAID_STATIC_RUNTIME_OK','entries':entries,'tree_sha256':hashlib.sha256(p.canonical(entries)).hexdigest(),'hardlink_groups':[]}
        self.manifest['manifest_sha256']=hashlib.sha256(p.canonical(self.manifest)).hexdigest()
        self.manifest_path=self.registry/(self.sha+'.json')
        self.manifest_path.write_text(json.dumps(self.manifest));self.manifest_path.chmod(0o444)
    def tearDown(self):
        for file in [self.current,*self.current.rglob('*')]:
            if not file.is_symlink(): file.chmod(0o755 if file.is_dir() else 0o644)
        self.temp.cleanup()
    def inspect(self, **kwargs):
        return p.inspect_reviewed_release(self.current,registry=self.registry,releases=self.releases,authority_uid=os.getuid(),release_uid=os.getuid(),**kwargs)
    def test_registered_exact_content_accepted_without_main_alignment(self):
        result=self.inspect();self.assertTrue(result['valid']);self.assertEqual(result['kind'],'reviewed_manifest');self.assertEqual(result['restartBaselines'],{});self.assertFalse(result['liveProofVerified'])
    def test_changed_content_fails_despite_same_git_head(self):
        f=self.current/'source.py';f.chmod(0o644);f.write_text('tampered observer\n');f.chmod(0o444)
        self.assertFalse(self.inspect()['valid'])
    def test_invalid_registry_never_becomes_absent_legacy(self):
        self.manifest_path.chmod(0o666)
        result=self.inspect();self.assertFalse(result['valid']);self.assertEqual(result['kind'],'invalid')
    def test_manifest_rehash_and_tree_checks(self):
        self.manifest_path.chmod(0o644);self.manifest['git_tree']='f'*40;self.manifest['manifest_sha256']='0'*64;self.manifest_path.write_text(json.dumps(self.manifest));self.manifest_path.chmod(0o444)
        self.assertFalse(self.inspect()['valid'])
    def test_symlink_and_unlisted_entry_fail(self):
        self.current.chmod(0o755);(self.current/'extra').symlink_to('/etc/hostname');self.current.chmod(0o555)
        self.assertFalse(self.inspect()['valid'])
    def test_external_hardlink_fails(self):
        os.link(self.current/'source.py',self.base/'outside');self.assertFalse(self.inspect()['valid'])
    def test_wrong_registry_owner_fails(self):
        result=p.inspect_reviewed_release(self.current,registry=self.registry,releases=self.releases,authority_uid=os.getuid()+1,release_uid=os.getuid());self.assertFalse(result['valid'])
    def test_absent_manifest_is_distinct_from_invalid(self):
        self.manifest_path.unlink();self.assertEqual(self.inspect()['kind'],'absent')
    def proof(self):
        rows=[]
        for i in (0,1):
            row={'observedAt':f'2026-10-02T11:0{i}:00Z'}
            for kind,pid in [('primary',100),('sidecar',101)]:
                row[kind]={'reportAt':row['observedAt'],'guardPass':True,'mainPid':pid,'startMonotonic':123,'restartCount':3 if kind=='primary' else 0,'cycles':10+i,'checkpoint':1000+100*i,'historicalNext':2000+100*i,'memoryCurrent':100,'memoryHigh':200,'memoryMax':300,'status':'healthy' if kind=='primary' else 'ok','financialCounters':dict.fromkeys(p.FINANCE,0),'memoryPressureEvents':{'high':0,'max':0,'oom':0,'oom_kill':0}}
            rows.append(row)
        return {'activationBaseline':{'primary':{'cycles':9,'checkpoint':900},'sidecar':{'cycles':9,'checkpoint':900,'historicalNext':1900}},'activatedAt':'2026-10-02T10:36:04Z','schema':'traid.onchain-observer-live-verification.v1','candidateSha':self.sha,'manifestSha256':self.manifest['manifest_sha256'],'scope':'observe_only_shadow_deployment','observations':rows}
    def test_only_two_stable_completed_progressing_observations_create_baseline(self):
        v=self.proof(); b=p.live_baselines(v,self.sha,self.manifest['manifest_sha256']);self.assertEqual(b['primary']['restartCount'],3)
        self.assertTrue(p.restart_count_ok(b['primary'],b['primary']))
        for field in ('mainPid','startMonotonic','restartCount'):
            bad={**b['primary'],field:b['primary'][field]+1};self.assertFalse(p.restart_count_ok(bad,b['primary']))
        self.assertFalse(p.restart_count_ok(b['primary'],None));self.assertFalse(p.restart_count_ok({'restartCount':False},None))
    def test_live_proof_missing_progress_finance_or_stable_process_rejected(self):
        for field,value in [('cycles',10),('checkpoint',1000),('mainPid',999),('restartCount',4),('historicalNext',2000)]:
            v=self.proof();v['observations'][1]['sidecar'][field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):p.live_baselines(v,self.sha,self.manifest['manifest_sha256'])
        v=self.proof();v['observations'][1]['primary']['financialCounters']['capital_movement_count']=1
        with self.assertRaises(ValueError):p.live_baselines(v,self.sha,self.manifest['manifest_sha256'])
        v=self.proof();v['observations'][1]['primary']['financialCounters']['capital_movement_count']=False
        with self.assertRaises(ValueError):p.live_baselines(v,self.sha,self.manifest['manifest_sha256'])
    def test_zero_restart_cannot_bypass_an_existing_changed_baseline(self):
        baseline={'restartCount':0,'mainPid':101,'startMonotonic':123}
        self.assertTrue(p.restart_count_ok(baseline,baseline))
        for key in ('mainPid','startMonotonic'):
            self.assertFalse(p.restart_count_ok({**baseline,key:baseline[key]+1},baseline))
        self.assertFalse(p.restart_count_ok(baseline,{**baseline,'restartCount':3}))
    def test_first_observation_must_have_progressed_since_actual_activation(self):
        v=self.proof();v['observations'][0]['sidecar']['cycles']=9
        with self.assertRaises(ValueError):p.live_baselines(v,self.sha,self.manifest['manifest_sha256'])
        v=self.proof();v['activationBaseline']['primary']['cycles']=10
        with self.assertRaises(ValueError):p.live_baselines(v,self.sha,self.manifest['manifest_sha256'])
        v=self.proof();v.pop('activationBaseline')
        with self.assertRaises(ValueError):p.live_baselines(v,self.sha,self.manifest['manifest_sha256'])
    def test_old_report_activity_or_future_report_cannot_prove_recovery(self):
        for timestamp in ('2026-09-15T23:35:12Z','2026-10-03T11:00:00Z'):
            v=self.proof();v['observations'][0]['sidecar']['reportAt']=timestamp
            with self.assertRaises(ValueError):p.live_baselines(v,self.sha,self.manifest['manifest_sha256'])
        v=self.proof();v['observations'][1]['primary']['guardPass']=False
        with self.assertRaises(ValueError):p.live_baselines(v,self.sha,self.manifest['manifest_sha256'])
    def test_zero_restart_without_process_identity_is_not_healthy(self):
        self.assertFalse(p.restart_count_ok({'restartCount':0},None))
        self.assertTrue(p.restart_count_ok({'restartCount':0,'mainPid':100,'startMonotonic':123},None))
    def test_bad_live_receipt_blocks_even_valid_manifest(self):
        q=self.registry/(self.sha+'.live-verification.json');q.write_text(json.dumps({'scope':'trading'}));q.chmod(0o444);self.assertFalse(self.inspect()['valid'])
    def test_embedded_remote_python_compiles_and_collects_both_identities(self):
        fake=types.ModuleType('lib.agent_runtime');fake.OPS=self.base
        for name in ('append_jsonl','standard_report','write_json_atomic'):setattr(fake,name,lambda *args,**kwargs:None)
        with patch.dict(sys.modules,{'lib.agent_runtime':fake}):
            spec=importlib.util.spec_from_file_location('monitor_under_test',Path(__file__).resolve().parents[1]/'traid_onchain_liquidation_shadow_monitor.py')
            m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        with patch.object(m.subprocess,'run',return_value=types.SimpleNamespace(returncode=0,stdout='{}',stderr='')) as call:
            m.remote_snapshot()
        remote=call.call_args.args[0][-1];code=remote.split("<<'PYREMOTE'",1)[1].split('\nPYREMOTE',1)[0]
        ast.parse(code);self.assertEqual(code.count("'-p','MainPID'"),2)

    def test_future_activation_and_observations_are_rejected(self):
        v=self.proof();v['activatedAt']='2099-01-01T00:00:00Z'
        for i,row in enumerate(v['observations']):
            row['observedAt']=f'2099-01-01T00:0{i+1}:00Z'
            for kind in ('primary','sidecar'):row[kind]['reportAt']=row['observedAt']
        with self.assertRaisesRegex(ValueError,'live_proof_future_observation'):p.live_baselines(v,self.sha,self.manifest['manifest_sha256'])
    def test_malformed_private_timestamp_remains_redacted(self):
        v=self.proof();v['observations'][0]['primary']['reportAt']='https://example.invalid/private-token'
        q=self.registry/(self.sha+'.live-verification.json');q.write_text(json.dumps(v));q.chmod(0o444)
        result=self.inspect();raw=json.dumps(result)
        self.assertFalse(result['valid']);self.assertEqual(result['error'],'live_proof_timestamp_invalid')
        self.assertNotIn('private-token',raw);self.assertNotIn('https://',raw)

    def test_monitor_blocks_reviewed_release_until_joint_live_proof(self):
        fake=types.ModuleType('lib.agent_runtime');fake.OPS=self.base
        captured={}
        def report(**kwargs):
            captured.update(kwargs)
            return {'generatedAt':'2026-10-02T12:00:00Z','capabilityId':'test','ok':kwargs['ok'],'status':kwargs['status'],'summary':kwargs['summary'],'counts':kwargs['counts']}
        fake.standard_report=report
        for name in ('append_jsonl','write_json_atomic'):setattr(fake,name,lambda *a,**k:None)
        with patch.dict(sys.modules,{'lib.agent_runtime':fake}):
            spec=importlib.util.spec_from_file_location('monitor_main_under_test',Path(__file__).resolve().parents[1]/'traid_onchain_liquidation_shadow_monitor.py')
            m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        for verified in (False,True):
            remote={'ok':True,'parsed':{'releaseProvenance':{'valid':True,'kind':'reviewed_manifest','liveProofVerified':verified}}}
            with patch.object(m,'remote_snapshot',return_value=remote),patch.object(m,'write_markdown'),patch('builtins.print'):
                with self.assertRaises(SystemExit):m.main()
            self.assertEqual('reviewed_release_completed_cycle_proof_missing' in captured['blocking_reasons'],not verified)
