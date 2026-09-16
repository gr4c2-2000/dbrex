# Verification that involves more than this repository.
#
# `npm test` proves the code is internally consistent. `make verify` proves an
# installation works: a container that has never seen dbrex installs it, builds
# it, and queries real MySQL, ClickHouse and S3.

E2E := test/e2e/docker-compose.yml

.PHONY: verify verify-build verify-shell verify-clean test

test:
	npm run typecheck
	npx vitest run

# The whole first-run path. Exits non-zero when any step fails.
verify:
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
