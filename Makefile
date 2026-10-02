# Verification that involves more than this repository.
#
# `npm test` proves the code is internally consistent. `make verify` proves an
# installation works: a container that has never seen dbrex installs it, builds
# it, and queries real MySQL, PostgreSQL, ClickHouse, Kafka and S3. RisingWave
# shares the PostgreSQL provider and has its own opt-in target.

E2E := test/e2e/docker-compose.yml

.PHONY: verify verify-run verify-install verify-risingwave verify-shell verify-clean test

test:
	npm run typecheck
	npx vitest run

# Everything: that an installation works, and that the result queries real
# engines. Exits non-zero when any step fails.
#
# Both stages build. The scripts are copied into the image rather than mounted,
# and `installer` and `runner` are separate services with separate images, so
# building only one of them ran the other's checks from a stale copy — which is
# a harness that can report on a script that is no longer on disk.
verify:
	docker compose -f $(E2E) run --rm --build installer; \
	  install=$$?; \
	  docker compose -f $(E2E) run --rm --build runner; \
	  run=$$?; \
	  docker compose -f $(E2E) down -v --remove-orphans >/dev/null 2>&1; \
	  exit $$(( install | run ))

# Just the installer: can someone who has nothing get a working dbrex?
verify-install:
	docker compose -f $(E2E) run --rm --build installer; \
	  status=$$?; \
	  docker compose -f $(E2E) down -v --remove-orphans >/dev/null 2>&1; \
	  exit $$status

# Just the behaviour, against a build that already exists.
verify-run:
	docker compose -f $(E2E) run --rm --build runner; \
	  status=$$?; \
	  docker compose -f $(E2E) down -v --remove-orphans >/dev/null 2>&1; \
	  exit $$status

# RisingWave, which shares the postgres provider. Opt-in: the image is 11 GB,
# so this is not part of `make verify` and nobody pulls it by accident.
verify-risingwave:
	docker compose -f $(E2E) --profile risingwave run --rm --build risingwave-runner; \
	  status=$$?; \
	  docker compose -f $(E2E) --profile risingwave down -v --remove-orphans >/dev/null 2>&1; \
	  exit $$status

# A shell in the same container, with the engines up. For working out why a
# step in verify.sh failed without waiting on a full run each time.
verify-shell:
	docker compose -f $(E2E) run --rm --entrypoint bash runner

verify-clean:
	docker compose -f $(E2E) down -v --remove-orphans
