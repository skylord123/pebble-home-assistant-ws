
# platform
#P="chalk"

VERSION=$(shell cat package.json | grep version | grep -o "[0-9][0-9]*\.[0-9][0-9]*")
NAME=$(shell cat package.json | grep '"name":' | head -1 | sed 's/,//g' |sed 's/"//g' | awk '{ print $2 }')

all: build

init_overlays:
	mkdir -p resources/data
	touch resources/data/OVL_aplite.bin
	touch resources/data/OVL_basalt.bin
	touch resources/data/OVL_chalk.bin
	touch resources/data/OVL_diorite.bin

build:
	pebble build

config:
	pebble emu-app-config --emulator $(PEBBLE_EMULATOR)

log:
	pebble logs --emulator $(PEBBLE_EMULATOR)

install:
	pebble install --emulator $(PEBBLE_EMULATOR)

clean:
	pebble clean
	rm src/js/weather_id.js

size:
	pebble analyze-size

logs:
	pebble logs --emulator $(PEBBLE_EMULATOR)

phone-logs:
	pebble logs --phone ${PEBBLE_PHONE}

screenshot:
	pebble screenshot --phone ${PEBBLE_PHONE}

deploy:
	pebble install --phone ${PEBBLE_PHONE}

timeline-on:
	pebble emu-set-timeline-quick-view on

timeline-off:
	pebble emu-set-timeline-quick-view off

wipe:
	pebble wipe

docker-build:
	docker run --rm --name rebble-build -v $(shell pwd):/pebble/ --workdir /pebble/ -e OPENWEATHERMAP_API_KEY rebble/pebble-sdk make

docker:
	docker run --rm -it --name rebble-build -v $(shell pwd):/pebble/ --workdir /pebble/ -e OPENWEATHERMAP_API_KEY -e PEBBLE_PHONE rebble/pebble-sdk

.PHONY: all build config log install clean size logs screenshot deploy timeline-on timeline-off wipe phone-logs weather-api