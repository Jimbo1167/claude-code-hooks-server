COMPOSE_FILE ?= ../mac-home-server/docker-compose.yml
COMPOSE := docker compose -f $(COMPOSE_FILE)
SERVICE := claude-hooks

.PHONY: deploy rebuild restart stop logs status dev clean

## deploy: Build and start the container (detached)
deploy:
	$(COMPOSE) up -d --build $(SERVICE)

## rebuild: Force full rebuild with no cache
rebuild:
	$(COMPOSE) build --no-cache $(SERVICE)
	$(COMPOSE) up -d $(SERVICE)

## restart: Restart without rebuilding
restart:
	$(COMPOSE) restart $(SERVICE)

## stop: Stop the container
stop:
	$(COMPOSE) stop $(SERVICE)

## logs: Tail container logs
logs:
	$(COMPOSE) logs -f $(SERVICE)

## status: Show container status
status:
	$(COMPOSE) ps $(SERVICE)

## dev: Run locally with auto-reload (no Docker)
dev:
	npm run dev

## clean: Stop container and remove local db
clean:
	$(COMPOSE) stop $(SERVICE) || true
	$(COMPOSE) rm -f $(SERVICE) || true
	rm -f data/hooks.db

## help: Show available targets
help:
	@grep '^## ' Makefile | sed 's/^## //'
