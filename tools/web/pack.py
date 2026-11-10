import json,base64,pathlib,re
pub=pathlib.Path('public')
html=(pub/'index.html').read_text()
m=json.loads(re.search(r'window.SB_MANIFEST = (.*?);</script>',html,re.S).group(1))
b64=lambda p,mt:f'data:{mt};base64,'+base64.b64encode((pub/p).read_bytes()).decode()
m['props']={k:b64(v,'model/gltf-binary') for k,v in m['props'].items()}
for c in m['chars']:
    c['ref']=b64(c['ref'],'image/png')
    if c['model']: c['model']=b64(c['model'],'model/gltf-binary')
app=(pub/'app.js').read_text()
out=re.sub(r'window.SB_MANIFEST = .*?;</script>',lambda _:'window.SB_MANIFEST = '+json.dumps(m)+';</script>',html,flags=re.S)
out=out.replace('<script type="module" src="app.js"></script>','<script type="module">'+app.replace('</script','<\\/script')+'</script>')
(pathlib.Path(__file__).parents[2]/'review/review-scene.html').write_text(out); print(round(len(out)/1e6,2),'MB')
