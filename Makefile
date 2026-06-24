# Winnow — Makefile wrapping the docker compose workflows.
#
# Two stacks share the same base file (docker-compose.yml):
#   - prod-ish : docker-compose.yml                         (baked build, NAS mounts)
#   - dev      : docker-compose.yml + docker-compose.dev.yml (bind-mount + hot reload)
#
# Quick start:
#   make init      # one-time: create .env from .env.dist
#   make dev       # build + run the dev stack with hot reload (foreground)
#   make help      # list every target
#
# `make` with no target prints this help.

# Use docker compose v2 (the `docker compose` plugin). Override on the CLI if you
# still have the legacy v1 binary, e.g.  make up COMPOSE="docker-compose".
COMPOSE     ?= docker compose
COMPOSE_DEV  = $(COMPOSE) -f docker-compose.yml -f docker-compose.dev.yml

# Service whose container most targets exec into (app / worker / migrate / postgres / redis).
SVC ?= app

.DEFAULT_GOAL := help

# ---------------------------------------------------------------------------
# Help — self-documenting: any target with a `## comment` shows up here.
# ---------------------------------------------------------------------------
.PHONY: help
help: ## Show this help
	@echo "Winnow — make targets:"
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
.PHONY: init
init: ## Create .env from .env.dist if it does not exist yet
	@if [ -f .env ]; then \
		echo ".env already exists — leaving it untouched."; \
	else \
		cp .env.dist .env && echo "Created .env from .env.dist — review it before 'make up'."; \
	fi

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
.PHONY: build
build: ## Build the prod image
	$(COMPOSE) build

.PHONY: build-dev
build-dev: ## Build the dev image
	$(COMPOSE_DEV) build

# ---------------------------------------------------------------------------
# Dev stack (hot reload, local ./nas folders)
# ---------------------------------------------------------------------------
.PHONY: dev
dev: init ## Build + run the dev stack in the foreground (hot reload)
	$(COMPOSE_DEV) up --build

.PHONY: dev-up
dev-up: init ## Run the dev stack detached (build if needed)
	$(COMPOSE_DEV) up -d --build

.PHONY: dev-down
dev-down: ## Stop the dev stack
	$(COMPOSE_DEV) down

.PHONY: dev-logs
dev-logs: ## Tail logs of the dev stack
	$(COMPOSE_DEV) logs -f

# ---------------------------------------------------------------------------
# Prod-ish stack
# ---------------------------------------------------------------------------
.PHONY: up
up: init ## Run the full stack detached (build if needed)
	$(COMPOSE) up -d --build

.PHONY: down
down: ## Stop the stack (keep volumes)
	$(COMPOSE) down

.PHONY: restart
restart: ## Restart the stack
	$(COMPOSE) restart

.PHONY: stop
stop: ## Stop containers without removing them
	$(COMPOSE) stop

.PHONY: start
start: ## Start previously-stopped containers
	$(COMPOSE) start

# ---------------------------------------------------------------------------
# Database / migrations
# ---------------------------------------------------------------------------
.PHONY: migrate
migrate: ## Apply database migrations (one-shot migrate service)
	$(COMPOSE) run --rm migrate

.PHONY: psql
psql: ## Open a psql shell on the postgres service
	$(COMPOSE) exec postgres psql -U winnow -d winnow

# ---------------------------------------------------------------------------
# Inspection
# ---------------------------------------------------------------------------
.PHONY: ps
ps: ## Show running containers
	$(COMPOSE) ps

.PHONY: logs
logs: ## Tail logs (all services, or one: make logs SVC=worker)
	@if [ "$(SVC)" = "app" ]; then $(COMPOSE) logs -f; else $(COMPOSE) logs -f $(SVC); fi

.PHONY: shell
shell: ## Open a shell in a service container (default app: make shell SVC=worker)
	$(COMPOSE) exec $(SVC) sh

# ---------------------------------------------------------------------------
# One-off tasks (run inside the app image)
# ---------------------------------------------------------------------------
.PHONY: scan
scan: ## Run the NAS scan script
	$(COMPOSE) run --rm app npm run scan

.PHONY: lint
lint: ## Run the linter
	$(COMPOSE) run --rm app npm run lint

.PHONY: typecheck
typecheck: ## Run the TypeScript type checker
	$(COMPOSE) run --rm app npm run typecheck

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
.PHONY: clean
clean: ## Stop the stack and remove its named volumes (DESTRUCTIVE: drops DB)
	$(COMPOSE) down -v

.PHONY: prune
prune: ## clean + remove images built by this project
	$(COMPOSE) down -v --rmi local
