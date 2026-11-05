import React from 'react';
import { AbsoluteFill, Composition, interpolate, registerRoot, useCurrentFrame } from 'remotion';

function motion(keys, frame, field, fallback) {
  if (!keys?.length) return fallback;
  if (keys.length === 1) return keys[0][field] ?? fallback;
  return interpolate(frame, keys.map(point => point.f), keys.map(point => point[field] ?? fallback), {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: t => t * t * (3 - 2 * t)
  });
}

function Track({ value, frame, uid, children }) {
  const keys = value.motion;
  const at = (field, fallback) => motion(keys, frame, field, fallback);
  const transform = 'translate(' + at('x', 0) + ' ' + at('y', 0) + ') rotate(' + at('rotation', 0) +
    ' ' + (value.originX ?? 0) + ' ' + (value.originY ?? 0) + ') translate(' + (value.originX ?? 0) +
    ' ' + (value.originY ?? 0) + ') scale(' + at('scaleX', 1) + ' ' + at('scaleY', 1) +
    ') translate(' + -(value.originX ?? 0) + ' ' + -(value.originY ?? 0) + ')';
  return <g transform={transform} opacity={at('opacity', 1)}>
    {value.clip && <defs><clipPath id={uid}><path d={value.clip} /></clipPath></defs>}
    <g clipPath={value.clip ? 'url(#' + uid + ')' : undefined}>{children}</g>
  </g>;
}

function Shape({ value, frame, uid }) {
  const style = { fill: value.fill ?? 'none', stroke: value.stroke, strokeWidth: value.strokeWidth,
    strokeLinecap: 'round', strokeLinejoin: 'round' };
  const reveal = value.motion?.some(point => point.draw !== undefined);
  const progress = motion(value.motion, frame, 'draw', 1);
  let shape;
  if (value.type === 'path') shape = <path {...style} d={value.d}
    pathLength={reveal ? 1 : undefined} strokeDasharray={reveal ? '1 1' : undefined}
    strokeDashoffset={reveal ? 1 - progress : undefined} />;
  else if (value.type === 'rect') shape = <rect {...style} x={value.x} y={value.y} width={value.w}
    height={value.h} rx={value.radius} />;
  else if (value.type === 'ellipse') shape = <ellipse {...style} cx={value.x} cy={value.y}
    rx={value.rx} ry={value.ry} />;
  else shape = <text {...style} x={value.x} y={value.y} fontSize={value.size} fontWeight={value.weight ?? 600}
    textAnchor={value.anchor} fontFamily="Microsoft YaHei, Noto Sans CJK SC, sans-serif">{value.text}</text>;
  return <Track value={value} frame={frame} uid={uid}>{shape}</Track>;
}

function Picture({ visual }) {
  const frame = useCurrentFrame();
  const index = visual.scenes.findIndex(scene => frame < scene.end);
  const scene = visual.scenes[index];
  if (!scene) return null;
  const local = frame - (visual.scenes[index - 1]?.end ?? 0);
  return <AbsoluteFill style={{ backgroundColor: scene.background }}>
    <svg width="1080" height="1920" viewBox="0 0 1080 1920">
      {scene.layers.map((layer, i) => <Track key={i} value={layer} frame={local} uid={'g' + i}>
        {layer.shapes.map((shape, j) => <Shape key={j} value={shape} frame={local} uid={'s' + i + '-' + j} />)}
      </Track>)}
    </svg>
  </AbsoluteFill>;
}

registerRoot(() => <Composition id="StudioVisualTrial" component={Picture} width={1080} height={1920} fps={30}
  durationInFrames={1} defaultProps={{ visual: { scenes: [{ end: 1, background: '#181b20', layers: [] }] } }}
  calculateMetadata={({ props }) => ({ durationInFrames: props.visual.scenes.at(-1).end })} />);
