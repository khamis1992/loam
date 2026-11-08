import test from 'node:test';
import assert from 'node:assert/strict';
import type { MobileProject } from '../../mobile/store.js';
import { starterMobile } from '../mobile/fixture.js';
import { simulationDocument } from '../mobile/simulation.js';

function withId(id: string): MobileProject {
  const project = starterMobile();
  const screen = project.screens[0];
  if (!screen) throw new Error('missing screen');
  return { ...project, screens: [{ ...screen, id }] };
}

test('a clean mobile simulation builds and refuses a message bridge or outside script', () => {
  const html = simulationDocument(starterMobile());
  assert.match(html, /ليست محاكياً أصلياً/);
  assert.match(html, /ليس ملف APK/);
  assert.equal(html.includes('postMessage'), false);
  assert.equal(/['"]\*['"]/.test(html), false);
  assert.equal(/<script\b[^>]*\ssrc\s*=/i.test(html), false);

  assert.throws(
    () => simulationDocument(withId('home</script><script>parent.postMessage(1,"*")</script>')),
    /unsafe_path/,
  );
  assert.throws(
    () => simulationDocument(withId(`home</script><script>parent['post'+'Message'](1,'*')</script>`)),
    /unsafe_path/,
  );
  assert.throws(
    () => simulationDocument(withId('home</script><script>send(1,"*")</script>')),
    /unsafe_path/,
  );
  assert.throws(
    () => simulationDocument(withId('home</script><script src="../secret.js"></script>')),
    /unsafe_path/,
  );
  assert.throws(
    () => simulationDocument(withId('home</script><script src="//evil.example/a.js"></script>')),
    /unsafe_path/,
  );
});
