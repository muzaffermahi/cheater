.PHONY: help install build test test-py gym clean

help:            ## Show this help message
	@echo "Cheater make targets:"
	@echo "  install   Install the Python launcher (pip install -e .) and the Pi extension (npm)"
	@echo "  build     Build the TypeScript Pi extension"
	@echo "  test      Run the TypeScript extension test suite"
	@echo "  test-py   Run the Python launcher tests"
	@echo "  gym       List Cheater Gym tasks (local benchmark)"
	@echo "  clean     Remove build output"

install:
	pip install -e .
	cd cheater-pi && npm install && npm run build && npm link

build:
	cd cheater-pi && npm run build

test:
	cd cheater-pi && npm test

test-py:
	python -m pytest tests/test_cli_commands.py -q

gym:
	cheater gym list

clean:
	rm -rf cheater-pi/dist
