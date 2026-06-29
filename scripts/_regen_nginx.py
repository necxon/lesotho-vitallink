"""Helper: regenerate openlmis nginx config and write to openlmis-ref-distro."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

with open(os.path.join(os.path.dirname(__file__), 'gen_openlmis_nginx.py'), encoding='utf-8') as f:
    src = f.read()
ns = {}
exec(compile(src.replace('if __name__', 'if False and __name__'), '<gen>', 'exec'), ns)
result = ns['generate']()

out = os.path.join(os.path.dirname(__file__), '..', '..', 'openlmis-ref-distro', 'config', 'nginx', 'openlmis-default.conf')
out = os.path.normpath(out)
with open(out, 'w', encoding='utf-8', newline='\n') as f:
    f.write(result)
print(f'Written {result.count(chr(10))} lines to {out}')
print(f'bkm-stubs-v3 present: {"bkm-stubs-v3" in result}')
