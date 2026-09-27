"""
Put the settings page into the pbw, next to appinfo.json.

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
        match = re.search(r"confVersion:\s*'([^']+)'", constants.read())
    if not match:
        raise ValueError('confVersion not found in ' + CONSTANTS_PATH)
    return os.path.join(root, 'config', 'v%s.html' % match.group(1))


def add_config_page(pbw_path, page_path, entry_name=PBW_ENTRY):
    """
    Rewrite the pbw with the page at its root and appinfo.json naming it.
    Rewriting rather than appending keeps a rebuild from stacking copies.
    """
    with io.open(page_path, 'rb') as page_file:
        page = page_file.read()

    with zipfile.ZipFile(pbw_path, 'r') as source:
        entries = [(info, source.read(info.filename))
                   for info in source.infolist() if info.filename != entry_name]

    replacement = pbw_path + '.tmp'
    with zipfile.ZipFile(replacement, 'w', zipfile.ZIP_DEFLATED) as target:
        for info, data in entries:
            if info.filename == 'appinfo.json':
                appinfo = json.loads(data.decode('utf-8'))
                if appinfo.get('configPage') != entry_name:
                    appinfo['configPage'] = entry_name
                    data = json.dumps(appinfo, indent=2, sort_keys=True).encode('utf-8')
            target.writestr(info, data)
        target.writestr(entry_name, page)

    os.remove(pbw_path)
    os.rename(replacement, pbw_path)


@conf
def bundle_config_page(ctx):
    root = ctx.path.abspath()
    page_path = config_page_source(root)
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
