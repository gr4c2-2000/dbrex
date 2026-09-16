# Verification that involves more than this repository.
#
# `npm test` proves the code is internally consistent. `make verify` proves an
# installation works: a container that has never seen dbrex installs it, builds
# it, and queries real MySQL, ClickHouse and S3.

E2E := test/e2e/docker-compose.yml

.PHONY: verify verify-run verify-install verify-shell verify-clean test

test:
	npm run typecheck
	npx vitest run

# Everything: that an installation works, and that the result queries real
# engines. Exits non-zero when any step fails.
verify:
	docker compose -f $(E2E) run --rm --build installer; \
	  install=$$?; \
	  docker compose -f $(E2E) run --rm runner; \
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

# A shell in the same container, with the engines up. For working out why a
# step in verify.sh failed without waiting on a full run each time.
verify-shell:
	docker compose -f $(E2E) run --rm --entrypoint bash runner

verify-clean:
	docker compose -f $(E2E) down -v --remove-orphans
