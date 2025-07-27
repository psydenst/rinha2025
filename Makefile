all:
	@printf "Launch configuration $(name)...\n"
	@cd payment-processor && docker compose up -d
	@docker compose up -d

re:
	@printf "Rebuild configuration $(name)...\n"
	@cd payment-processor && docker compose build --no-cache
	@cd payment-processor && docker compose up -d
	@docker compose build --no-cache
	@docker compose up -d

down:
	@printf "Stopping configuration $(name)...\n"
	@cd payment-processor && docker compose down
	@docker compose down

clean: down
	@printf "Cleaning configuration $(name)...\n"
	@docker system prune -a

fclean:
	@printf "Total clean of all configurations docker\n"
	@docker stop $$(docker ps -qa)
	@docker system prune --all --force --volumes
	@docker network prune --force
	@docker volume prune --force

.PHONY: all re down clean fclean

