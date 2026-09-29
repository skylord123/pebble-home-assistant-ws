"""
Put the settings page and the plugin into the pbw, next to appinfo.json.

Newer Pebble phone apps open the page named by appinfo.json `configPage`
straight out of the pbw and let it message the app's JS while it is open.
`pebble build` only bundles the binaries, resources and JS, so the page is
added once the bundle step has run. Phone apps that predate the key ignore
both it and the extra file, and keep opening the hosted copy of the same page.

The page is whichever config/vN.html Constants.js names as confVersion, so the
hosted and bundled copies never drift apart.
"""
import io
import json
import os
import re
import zipfile

from waflib import Logs
from waflib.Configure import conf

CONSTANTS_PATH = os.path.join('src', 'js', 'app', 'Constants.js')
PBW_ENTRY = 'config.html'


def config_page_source(root):
    with io.open(os.path.join(root, CONSTANTS_PATH), encoding='utf-8') as constants:
        match = re.search(r"confVersion:\s*['\"]([^'\"]+)['\"]", constants.read())
    if not match:
        raise ValueError('confVersion not found in ' + CONSTANTS_PATH)
    return os.path.join(root, 'config', 'v%s.html' % match.group(1))


def rewrite_pbw(pbw_path, files, appinfo_updates):
    """
    Rewrite the pbw with `files` (zip name -> bytes) at its root and
    `appinfo_updates` merged into its appinfo.json. Rewriting rather than
    appending keeps a rebuild from stacking copies.
    """
    with zipfile.ZipFile(pbw_path, 'r') as source:
        entries = [(info, source.read(info.filename))
                   for info in source.infolist() if info.filename not in files]

    replacement = pbw_path + '.tmp'
    with zipfile.ZipFile(replacement, 'w', zipfile.ZIP_DEFLATED) as target:
        for info, data in entries:
            if info.filename == 'appinfo.json':
                appinfo = json.loads(data.decode('utf-8'))
                if any(appinfo.get(key) != value for key, value in appinfo_updates.items()):
                    appinfo.update(appinfo_updates)
                    data = json.dumps(appinfo, indent=2, sort_keys=True).encode('utf-8')
            target.writestr(info, data)
        for name in sorted(files):
            target.writestr(name, files[name])

    os.remove(pbw_path)
    os.rename(replacement, pbw_path)


def add_config_page(pbw_path, page_path, entry_name=PBW_ENTRY):
    """The page at the pbw's root, and appinfo.json naming it"""
    with io.open(page_path, 'rb') as page_file:
        page = page_file.read()
    rewrite_pbw(pbw_path, {entry_name: page}, {'configPage': entry_name})


def add_plugin(pbw_path, script_path, manifest_path):
    """
    The plugin's script at the pbw's root, and its manifest as appinfo.json's
    `plugin` block, which is where the phone looks for it. The manifest names
    the script, so the two always agree.
    """
    with io.open(manifest_path, encoding='utf-8') as manifest_file:
        manifest = json.load(manifest_file)
    with io.open(script_path, 'rb') as script_file:
        script = script_file.read()
    name = manifest.get('script') or 'plugin.js'
    rewrite_pbw(pbw_path, {name: script}, {'plugin': manifest})
    return name


def built_pbws(ctx):
    build_dir = ctx.bldnode.abspath()
    return [os.path.join(build_dir, name)
            for name in os.listdir(build_dir) if name.endswith('.pbw')]


@conf
def bundle_config_page(ctx):
    root = ctx.path.abspath()
    try:
        page_path = config_page_source(root)
    except (IOError, OSError, ValueError) as err:
        ctx.fatal('Cannot work out which config page to bundle: %s' % err)
    if not os.path.exists(page_path):
        ctx.fatal('Config page %s does not exist' % os.path.relpath(page_path, root))

    build_dir = ctx.bldnode.abspath()
    pbws = [os.path.join(build_dir, name)
            for name in os.listdir(build_dir) if name.endswith('.pbw')]
    if not pbws:
        ctx.fatal('No pbw found in %s to add the config page to' % build_dir)

    for pbw in pbws:
        add_config_page(pbw, page_path)
        Logs.info('Bundled %s into %s as %s' % (
            os.path.relpath(page_path, root), os.path.relpath(pbw, root), PBW_ENTRY))


@conf
def bundle_plugin(ctx, script_path):
    """
    The plugin (plugin/): the script the build concatenated, and the manifest
    from plugin/manifest.json. Phones that do not know about plugins ignore
    both.
    """
    root = ctx.path.abspath()
    manifest_path = os.path.join(root, 'plugin', 'manifest.json')
    if not os.path.exists(script_path):
        ctx.fatal('Plugin script %s was not built' % os.path.relpath(script_path, root))
    try:
        for pbw in built_pbws(ctx):
            name = add_plugin(pbw, script_path, manifest_path)
            Logs.info('Bundled the plugin into %s as %s' % (os.path.relpath(pbw, root), name))
    except (IOError, OSError, ValueError) as err:
        ctx.fatal('Cannot bundle the plugin: %s' % err)
