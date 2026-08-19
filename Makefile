.PHONY: dev dev-server dev-web build run docker check clean

dev: ## run backend + vite together (two terminals is nicer, but this works)
	@echo "backend :8080  ->  web :5173  (open http://localhost:5173)"
	@$(MAKE) -j2 dev-server dev-web

dev-server:
	cd server && go run .

dev-web:
	cd web && npm run dev

build: ## production build: web -> server/web-dist -> single static binary
	cd web && npm run build
	rm -rf server/web-dist && cp -r web/dist server/web-dist
	touch server/web-dist/.gitkeep   # keeps the embed placeholder tracked
	cd server && CGO_ENABLED=0 go build -o dj-pro .
	@echo "built ./server/dj-pro"

run: build
	cd server && ./dj-pro

docker:
	docker compose up --build

check:
	cd server && gofmt -l . && go vet ./...
	cd web && npm run check

clean:
	rm -rf web/dist server/web-dist server/dj-pro

smoke: ## end-to-end protocol + sync test against a running server
	BASE=$${BASE:-http://localhost:8080} DJ_PASSWORD=$${DJ_PASSWORD:-letmein} node test/smoke.mjs
