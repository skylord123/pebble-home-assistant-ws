from waflib.Configure import conf


@conf
def appinfo_bitmap_to_png(ctx, appinfo_json):
    # Check if supports_bitmap_resource exists, otherwise assume it's supported
    # (SDK 4.x and later support bitmap resources)
    supports_bitmap = True
    if hasattr(ctx, 'supports_bitmap_resource'):
        supports_bitmap = ctx.supports_bitmap_resource()

    if not supports_bitmap:
        for res in appinfo_json['resources']['media']:
            if res['type'] == 'bitmap':
                res['type'] = 'png'
