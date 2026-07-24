SHELL := /bin/bash

up:
	cd compose && docker compose up -d

ps:
	cd compose && docker compose ps

down:
	cd compose && docker compose down

logs:
	cd compose && docker compose logs -f --tail=200

prompt-packs:
	sudo ./scripts/extract_prompt_packs.py

schedule-manifest:
	./scripts/build_temporal_schedule_manifest.py

# Architecture agents v2
catalog-v2:
	PYTHONPATH=/srv/rbw-agents-oss/packages /srv/rbw-agents-oss/.venv/bin/python -m rbw_agent_runtime catalog build

validate-v2:
	PYTHONPATH=/srv/rbw-agents-oss/packages /srv/rbw-agents-oss/.venv/bin/python -m rbw_agent_runtime catalog validate

doctor-v2:
	PYTHONPATH=/srv/rbw-agents-oss/packages /srv/rbw-agents-oss/.venv/bin/python -m rbw_agent_runtime doctor

guard-v2:
	/srv/rbw-agents-oss/.venv/bin/python /srv/rbw-agents-oss/scripts/oss_architecture_v2_guard.py

selftest-v2:
	/srv/rbw-agents-oss/.venv/bin/python /srv/rbw-agents-oss/scripts/oss_architecture_v2_selftest.py
