import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { check } from './store.mjs';

// Based on 视频平台 src/runtime/remotion-scene-compiler.ts at 57daf4757089ab9e92f86f63a0c094db7fce6a55.
// Retains the script-direct scene surface. Media and legacy layout adapters belong to the source project.
const threeNames = ['Vector2', 'Vector3', 'Euler', 'Quaternion', 'Color', 'Shape', 'Path',
  'BufferGeometry', 'Float32BufferAttribute', 'FrontSide', 'BackSide', 'DoubleSide'];
const tags = new Set(('AbsoluteFill SafeArea BackgroundLayer ThreeCanvas div span p svg g defs symbol use path rect circle ' +
  'ellipse line polyline polygon text tspan clipPath mask pattern linearGradient radialGradient stop filter ' +
  'feGaussianBlur feDropShadow feColorMatrix feBlend feOffset feComposite feMerge feMergeNode feFlood ' +
  'mesh group ambientLight directionalLight pointLight spotLight hemisphereLight boxGeometry planeGeometry ' +
  'sphereGeometry cylinderGeometry coneGeometry torusGeometry ringGeometry icosahedronGeometry extrudeGeometry ' +
  'shapeGeometry bufferGeometry bufferAttribute meshBasicMaterial meshStandardMaterial meshPhongMaterial ' +
  'meshPhysicalMaterial lineBasicMaterial lineSegments points pointsMaterial').split(' '));
const forbidden = /^(?:require|process|import|exports|module|global|globalThis|window|document|navigator|location|history|top|parent|self|fetch|XMLHttpRequest|WebSocket|EventSource|Worker|SharedWorker|ServiceWorker|Notification|indexedDB|caches|localStorage|sessionStorage|eval|Function|AsyncFunction|constructor|prototype|__proto__|caller|callee|arguments|Reflect|Proxy|Object|performance|Date|crypto|randomUUID|requestAnimationFrame|setTimeout|setInterval|queueMicrotask|createElement|useEffect|useLayoutEffect|useRef|useFrame|useThree|useLoader|Math\.random)$/u;
const scopedBrowserNames = new Set(['top', 'parent', 'self', 'location', 'history']);
const noProps = /^(?:on[A-Z]|ref$|dangerouslySetInnerHTML$|src$|srcSet$|action$|formAction$|gl$|events$|eventSource$|frameloop$)/u;
const local = /^#[A-Za-z][A-Za-z0-9_-]*$/u;
const localPaint = /^url\(#[A-Za-z][A-Za-z0-9_-]*\)$/u;

export const sceneSurface = [
  '返回 scene-local TSX 函数体（可声明局部纯函数和组件，末尾 return JSX）。禁止 imports、网络、外部资产、DOM、时钟、事件、ref、JSX 属性展开、任意循环和异步。',
  '提供 frame（本段帧号）、fps、durationInFrames、interpolate、spring、Easing、random（稳定种子）、frameProgress(a,b)、sceneProgress(a,b)。所有运动从 frame 求值。',
  'Remotion HTML/SVG 可用；SVG 可用路径、遮罩、裁剪、滤镜和渐变。url(#局部标识) 和 href="#局部标识" 只能写字面值。可按内容用透视、程序化几何、绘制顺序及材质。',
  '需要真正 3D 时用 <ThreeCanvas width={1080} height={1920} camera={{position:[0,0,8],fov:45}}>，可声明 mesh/group、几何、材质和灯光。',
  'THREE 仅开放 ' + threeNames.join(', ') + '。函数体允许 AbsoluteFill、SafeArea 和 BackgroundLayer。字幕统一在渲染后合成。',
  '根画幅 1080×1920。只实现当前时段的原创视觉，保留真实字幕空间，不生成额外字幕轨。'
].join('\n');

export function validateSceneSource(body) {
  check(typeof body === 'string' && body.trim() && Buffer.byteLength(body) <= 100_000, '段源码缺失或过大');
  const wrapped = 'function ModelScene(){\n' + body + '\n}';
  const file = 'scene.tsx';
  const source = ts.createSourceFile(file, wrapped, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const diagnostic = ts.transpileModule(wrapped, { fileName: 'scene.tsx', reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } })
    .diagnostics?.find(item => item.category === ts.DiagnosticCategory.Error);
  check(!diagnostic, diagnostic && '段源码 TSX 无效：' + ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
  check(source.statements.length === 1 && ts.isFunctionDeclaration(source.statements[0]), '只允许当前场景函数体');
  let checker;
  function localBinding(node) {
    if (!checker) {
      const options = { noLib: true, noResolve: true, target: ts.ScriptTarget.ES2022 };
      const host = ts.createCompilerHost(options);
      host.getSourceFile = name => name === file ? source : undefined;
      checker = ts.createProgram([file], options, host).getTypeChecker();
    }
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
    return symbol?.declarations?.some(declaration => declaration.getSourceFile() === source);
  }
  function visit(node) {
    const name = node.getText(source);
    const identifier = ts.isIdentifier(node) ? node.text : '';
    check((!forbidden.test(identifier) || (scopedBrowserNames.has(identifier) && localBinding(node))) && identifier !== 'React',
      '场景使用了未开放的标识：' + identifier);
    check(![ts.SyntaxKind.ImportKeyword, ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.WhileStatement,
      ts.SyntaxKind.DoStatement, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.ForInStatement,
      ts.SyntaxKind.AwaitExpression, ts.SyntaxKind.AsyncKeyword, ts.SyntaxKind.ThisKeyword,
      ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.ClassExpression, ts.SyntaxKind.TaggedTemplateExpression,
      ts.SyntaxKind.JsxSpreadAttribute].includes(node.kind), '场景使用了未开放的语法：' + ts.SyntaxKind[node.kind]);
    if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      check(ts.isNumericLiteral(key) && node.expression.getText(source) !== 'THREE', '使用 array.at(index) 访问动态数组下标');
    }
    if (ts.isPropertyAccessExpression(node)) {
      check(name !== 'Math.random' && (node.expression.getText(source) !== 'THREE' || threeNames.includes(node.name.text)),
        '场景使用了未开放的属性：' + name);
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      check(tags.has(tag) || /^[A-Z][a-zA-Z0-9]*$/u.test(tag), '场景标签未开放：' + tag);
    }
    if (ts.isJsxAttribute(node)) {
      const attr = node.name.getText(source);
      const value = node.initializer;
      check(!noProps.test(attr) && (!['href', 'xlinkHref'].includes(attr) ||
        (value && ts.isStringLiteral(value) && local.test(value.text))), '场景属性未开放：' + attr);
    }
    if (ts.isStringLiteralLike(node)) {
      check(!forbidden.test(node.text) && !/https?:\/\/|data:|javascript:|file:\/|@import/iu.test(node.text) &&
        (!/url\s*\(/iu.test(node.text) || localPaint.test(node.text)), '场景仅能使用局部 SVG 引用');
    }
    if (ts.isTemplateExpression(node)) check(!/url\s*\(|https?:|data:|javascript:/iu.test(name), '禁止动态外部引用');
    ts.forEachChild(node, visit);
  }
  visit(source);
  return body;
}

export async function renderSceneProject(dir, segments) {
  const total = segments.at(-1).end;
  const usesThree = segments.some(item => /\b(?:THREE|ThreeCanvas)\b/u.test(item.tsx));
  const three = usesThree
    ? 'import {ThreeCanvas} from "@remotion/three"; import {' + threeNames.join(',') +
      '} from "three"; const THREE=Object.freeze({' + threeNames.join(',') + '});'
    : '';
  const declarations = segments.map((item, index) => {
    const length = item.end - (segments[index - 1]?.end ?? 0);
    const body = validateSceneSource(item.tsx);
    return 'function Segment' + index + '(){const frame=useCurrentFrame(),fps=30,durationInFrames=' + length + ';' +
      'const frameProgress=(a,b)=>interpolate(frame,[a,b],[0,1],{extrapolateLeft:"clamp",extrapolateRight:"clamp"});' +
      'const sceneProgress=(a,b)=>frameProgress(a*(durationInFrames-1),b*(durationInFrames-1));\n' + body + '\n}';
  });
  const sequence = segments.map((item, index) => {
    const start = segments[index - 1]?.end ?? 0;
    return '<Sequence from={' + start + '} durationInFrames={' + (item.end - start) + '}><Segment' + index + '/></Sequence>';
  });
  const entry = join(dir, 'studio-scene-project.tsx');
  await writeFile(entry, [
    'import React from "react"; import {AbsoluteFill,Composition,Sequence,interpolate,spring,Easing,random,useCurrentFrame,registerRoot} from "remotion";',
    three,
    'const SafeArea=AbsoluteFill,BackgroundLayer=AbsoluteFill;',
    ...declarations,
    'const FullVideo=()=> <AbsoluteFill style={{backgroundColor:"#111"}}>' + sequence.join('') + '</AbsoluteFill>;',
    'registerRoot(()=> <Composition id="StudioSceneProject" component={FullVideo} width={1080} height={1920} fps={30} durationInFrames={' + total + '} />);'
  ].join('\n'), { flag: 'wx' });
  const modules = fileURLToPath(new URL('./node_modules', import.meta.url));
  const { bundle } = await import('@remotion/bundler');
  const { renderMedia, selectComposition } = await import('@remotion/renderer');
  const serveUrl = await bundle({ entryPoint: entry, outDir: join(dir, 'bundle'), onProgress: () => {},
    webpackOverride: config => ({ ...config, resolve: { ...config.resolve, modules: [modules, 'node_modules'] } }) });
  const options = { serveUrl, browserExecutable: process.env.STUDIO_REMOTION_BROWSER || undefined,
    logLevel: 'error', ...(usesThree ? { chromiumOptions: { gl: 'angle' } } : {}) };
  const composition = await selectComposition({ ...options, id: 'StudioSceneProject' });
  const outputLocation = join(dir, 'picture.mp4');
  await renderMedia({ ...options, composition, codec: 'h264', muted: true, concurrency: 3, outputLocation });
  return outputLocation;
}
