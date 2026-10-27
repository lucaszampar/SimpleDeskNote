UUID := simpledesknote@lucas.local
DIST := dist
ZIP  := $(DIST)/$(UUID).shell-extension.zip

.PHONY: pack install uninstall clean

# Build the zip that can be installed locally or uploaded to extensions.gnome.org
pack:
	mkdir -p $(DIST)
	gnome-extensions pack $(UUID) --force --out-dir=$(DIST) \
		--extra-source=icons --extra-source=../LICENSE

install: pack
	gnome-extensions install --force $(ZIP)
	@echo "Log out and back in, then run: gnome-extensions enable $(UUID)"

uninstall:
	gnome-extensions uninstall $(UUID)

clean:
	rm -rf $(DIST)
