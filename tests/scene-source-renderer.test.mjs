import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSceneSource } from '../engine/scene-source-renderer.mjs';

test('scene source can name a local face top without granting browser globals', () => {
  const body = 'const face = ({top}) => <path fill={top}/>; return <svg>{face({top:"#aaaaaa"})}</svg>;';
  assert.equal(validateSceneSource(body), body);
  assert.throws(() => validateSceneSource('return <div>{top}</div>;'), /未开放的标识/);
  assert.throws(() => validateSceneSource('return <div>{({top})}</div>;'), /未开放的标识/);
  assert.throws(() => validateSceneSource('const n="con"+"structor"; return <div>{[].map[n]}</div>;'), /动态数组下标/);
});

test('scene source supports local SVG and Three.js without remote media or event handlers', () => {
  const svg = 'return <svg><defs><clipPath id="c"><rect width={2}/></clipPath></defs><g clipPath="url(#c)"/></svg>;';
  assert.equal(validateSceneSource(svg), svg);
  const three = 'return <ThreeCanvas width={1080} height={1920}><mesh><boxGeometry args={[1,1,1]}/></mesh></ThreeCanvas>;';
  assert.equal(validateSceneSource(three), three);
  assert.throws(() => validateSceneSource('return <svg><use href="https://example.org/p.svg#x"/></svg>;'), /未开放/);
  assert.throws(() => validateSceneSource('return <div onClick={()=>null}/>;'), /未开放/);
});
