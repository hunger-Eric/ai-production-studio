import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { check, rootAt, slug } from './store.mjs';
import * as studio from './studio.mjs';
import { testSpeech } from './studio-tts.mjs';
import { localSpeech, localVoiceProfile, renderLocalVoice } from './local-voice.mjs';
import { productionApply, productionFeedback, productionNext, stageInputs } from './production.mjs';
import { animationPlan, animationDispatch, animationDelivery } from './animation-dispatch.mjs';
import { earshotCandidates, earshotMix, earshotPlanInput, earshotMixInput } from './earshot.mjs';
import { publicationPrepare, publicationInput } from './publication.mjs';
import { visualTrial, visualTrialInputs } from './visual-reference-trial.mjs';
import { sceneProjectInputs, sceneStyleList, sceneStyleRead, sceneProjectPlan, sceneProjectNext,
  sceneProjectStatus, sceneProjectPreview, sceneProjectFrames, sceneProjectExport, sceneProjectCaptionFit,
  prepareSceneProject } from './scene-production.mjs';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const markdown = z.string().min(1).max(512 * 1024);
const stage = z.enum(['topic', 'research', 'direction', 'draft', 'edit']);
const modelStage = z.enum(['draft', 'edit']);
const readOnly = { readOnlyHint: true, openWorldHint: false };
const writeOnce = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const run = { runId: id };
const checkpoint = { ...run, stage, taskSha256: sha };

async function main() {
  const { values } = parseArgs({ options: { workspace: { type: 'string' }, 'authorize-run': { type: 'string' },
    'animate-run': { type: 'string' }, 'animate-retry-dispatch': { type: 'string' },
    'visual-trial-run': { type: 'string' }, 'visual-trial-retry-dispatch': { type: 'string' } } });
  check(values.workspace && isAbsolute(values.workspace), '启动 MCP 时须提供 --workspace <已初始化仓库的绝对路径>');
  const root = await rootAt(values.workspace);
  const workspace = await studio.workspaceInfo(root);
  const localProfile = workspace.mode === 'production' && await localVoiceProfile(root);
  const authorizedRun = values['authorize-run'];
  const animationRun = values['animate-run'];
  const animationRetry = values['animate-retry-dispatch'];
  const visualRun = values['visual-trial-run'];
  const visualRetry = values['visual-trial-retry-dispatch'];
  check(!visualRetry || (visualRun && sha.safeParse(visualRetry).success), '试做重试必须绑定原派发 SHA');
  if (visualRun) {
    check(workspace.mode === 'production', '夹具仓库禁止真实动画作者请求');
    await studio.loadRun(root, slug(visualRun));
  }
  check(!animationRetry || (animationRun && sha.safeParse(animationRetry).success), '动画重试授权必须绑定任务及原派发 SHA');
  if (animationRun) {
    check(workspace.mode === 'production', '夹具仓库禁止真实动画作者请求');
    await studio.loadRun(root, slug(animationRun));
    await prepareSceneProject(root, animationRun);
  }
  if (authorizedRun) {
    check(workspace.mode === 'production', '夹具仓库禁止真实 Gemini 请求');
    await studio.loadRun(root, slug(authorizedRun));
    check(process.env.GEMINI_API_KEY?.trim(), '授权的 MCP 进程缺少 GEMINI_API_KEY');
  }
  const server = new McpServer({ name: 'ai-production-studio', version: studio.version });

  function tool(name, description, inputSchema, annotations, execute, multimodal = false) {
    server.registerTool(name, { description, inputSchema: z.strictObject(inputSchema), annotations }, async args => {
      try {
        const current = await studio.workspaceInfo(root);
        check(current.workspaceId === workspace.workspaceId, '工作区身份已变化，请重新连接');
        const result = await execute(args);
        if (multimodal) return { content: [{ type: 'text', text: JSON.stringify(result.text) },
          ...(result.images ?? (result.image ? [result.image] : []))] };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
  }

  tool('workspace_info', '查看本连接绑定的客户仓库和运行模式。', {}, readOnly, () => workspace);
  tool('run_start', '按用户明确的新任务建立工作单。续跑使用已有 runId。', { brief: markdown },
    { ...writeOnce, idempotentHint: false }, ({ brief }) => studio.start(root, brief));
  tool('run_status', '查询已有任务的当前阶段和结果 SHA。', run, readOnly,
    async ({ runId }) => {
      const status = await studio.status(root, runId);
      if (status.state !== 'needs_tts') return status;
      const production = await productionNext(root, runId);
      if (production.state === 'needs_tts') return status;
      return { ...status, state: production.state, narrationState: status.state, production: production.completed };
    });
  tool('run_next', '按已有 runId 读取当前阶段的冻结正文和工作单 SHA。', run, readOnly,
    async ({ runId }) => {
      const task = await studio.next(root, runId);
      return task.state === 'needs_tts' ? productionNext(root, runId) : task;
    });
  tool('stage_submit', '提交工作单正文。正式仓库只接受选题、研究和方向，origin 说明实际来源。',
    { ...checkpoint, text: markdown, origin: z.string().min(1).max(4000).optional() }, writeOnce,
    ({ runId, ...input }) => studio.submit(root, runId, input));
  tool('author_recover', '将已保存的 Gemini 响应恢复到对应阶段。该工具只读取本地响应。',
    { ...checkpoint, stage: modelStage }, writeOnce,
    ({ runId, ...input }) => studio.author(root, runId, { ...input, allowNetwork: false }));
  if (authorizedRun) {
    tool('author_generate', '执行已由操作者授权的单个任务的 Gemini 初稿或表达编辑。',
      { ...checkpoint, stage: modelStage }, { ...writeOnce, openWorldHint: true },
      ({ runId, ...input }) => {
        check(runId === authorizedRun, '这个任务没有模型调用授权');
        return studio.author(root, runId, { ...input, allowNetwork: true });
      });
    if (!localProfile) tool('tts_test', '使用已授权任务的最终润色正文测试 Gemini 配音，返回本地 WAV 与回执。',
      { ...run, narrationSha256: sha }, { ...writeOnce, openWorldHint: true },
      ({ runId, narrationSha256 }) => {
        check(runId === authorizedRun, '这个任务没有配音授权');
        return testSpeech(root, runId, narrationSha256);
      });
  }
  if (localProfile) {
    const parts = z.array(z.string().min(1).max(240)).min(1).max(60);
    tool('local_voice_render', '用本工作区配置的本人音色，在本机 CUDA 生成明确指定的旁白分段。适合既有视频换声试听。',
      { jobId:id, parts }, writeOnce, ({ jobId, parts }) => renderLocalVoice(root,jobId,parts));
    tool('tts_local', '按已冻结的最终口播在本机 CUDA 生成配音，字幕阶段自动读取回执。',
      { ...run, narrationSha256:sha, parts }, writeOnce,
      ({ runId, narrationSha256, parts }) => localSpeech(root,runId,narrationSha256,parts));
  }
  tool('narration_export', '导出完成表达编辑的口播稿并校验正文。', run, writeOnce,
    ({ runId }) => studio.exportNarration(root, runId));
  tool('feedback_write', '按结果 SHA 和已使用的知识节点写入并读回反馈。adopted 仅传客户明确采纳的要求。',
    { ...run, stage, node: id, resultSha256: sha, feedbackId: id, comment: markdown, adopted: markdown.optional() },
    writeOnce, ({ runId, ...input }) => studio.feedback(root, runId, input));
  tool('production_next', '读取同一任务的制作阶段、已验产物、当前工作单 SHA 和 Obsidian 要求。', run,
    readOnly, ({ runId }) => productionNext(root, runId));
  const productionDescriptions = {
    align: '用逐字保留口播的短句和本地 Whisper 对齐真实 WAV。',
    picture: '登记无声竖屏画面段，按时间轴合成带字幕和口播的粗剪。',
    sound: '按审看后的声音决定执行混音，校验素材 SHA 和时长。',
    preview: '用当前画面和混音导出预览，完成全片技术检查。',
    review: '负责人记录实际审看并接受当前预览，技术验收用 technical_validation。',
    delivery: '从已接受预览生成本地成片、封面和说明。'
  };
  for (const stage of Object.keys(stageInputs)) {
    tool('production_' + stage, productionDescriptions[stage],
      { ...run, taskSha256: sha, input: stageInputs[stage] }, writeOnce,
      ({ runId, taskSha256, input }) => productionApply(root, runId, stage, taskSha256, input));
  }
  tool('production_feedback', '按制作阶段结果 SHA 写入该阶段消费的 Obsidian 节点并读回。',
    { ...run, stage: z.enum(Object.keys(stageInputs)), node: id, resultSha256: sha, feedbackId: id,
      comment: markdown, adopted: markdown.optional() }, writeOnce,
    ({ runId, ...input }) => productionFeedback(root, runId, input));
  tool('animation_plan', '冻结同一动画作者的连续分段计划。ends 为各段结束帧，不含该帧。',
    { ...run, taskSha256: sha, ends: z.array(z.number().int().positive()).min(1).max(24) }, writeOnce,
    ({ runId, taskSha256, ends }) => animationPlan(root, runId, taskSha256, ends));
  if (animationRun) {
    tool('animation_dispatch', '在 DeepSeek Harness ACP 派发已授权任务的当前段。后续段续接同一作者会话。',
      run, { ...writeOnce, idempotentHint: false, openWorldHint: true }, ({ runId }) => {
        check(runId === animationRun, '此任务未授权动画作者请求');
        return animationDispatch(root, runId, animationRetry);
      });
    const active = runId => {
      check(runId === animationRun, '此任务未授权正式动画作者请求');
      return runId;
    };
    tool('scene_project_inputs', '正式动画入口。读取已对齐口播、原字幕时轴和 Obsidian 动画要求，供你决定整片设计。',
      run, readOnly, ({ runId }) => sceneProjectInputs(root, active(runId)));
    tool('scene_style_catalog', '浏览 Obsidian 的画风目录。无 series 时列系列；有 series 时列条目，供你按题材选择。',
      { series: z.string().max(8).optional() }, readOnly, ({ series }) => sceneStyleList(root, series));
    tool('scene_style_read', '实际读取候选画风的完整原提示词和可用静帧，按当前任务保存来源和 SHA。',
      { ...run, key: z.string().max(32) }, { ...writeOnce, openWorldHint: true },
      ({ runId, key }) => sceneStyleRead(root, active(runId), key), true);
    tool('scene_project_plan', '登记 Harness 为整片选定的画风、具体设计和分段。已选条目须先实际读取。referenceDecisions 按 styleKeys 顺序记录实际参考的配色与画法，再说明本片需要改动的部分。',
      { ...run, styleKeys: z.array(z.string().max(32)).min(1).max(3),
        ends: z.array(z.number().int().positive()).min(1).max(24), design: z.string().min(1).max(12000),
        referenceDecisions: z.array(z.strictObject({
          key: z.string().max(32),
          palette: z.string().trim().min(1).max(1600).describe('按实际静帧记录占画面主要面积的颜色、主体与背景的色彩和明暗关系。无静帧则标明依据为原文。'),
          appearance: z.string().trim().min(1).max(1600).describe('列出要保留的构图、材质、空间、运动做法，区分实际看到和原文所述。'),
          changes: z.array(z.string().trim().min(1).max(400)).max(8).describe('写明必须因题材或输出规格改动的地方及原因。没有改动时给空数组。')
        })).min(1).max(3).optional() },
      writeOnce, ({ runId, ...choice }) => sceneProjectPlan(root, active(runId), choice));
    tool('scene_project_status', '查询当前整片的设计、分段源码、统一预览和本地导出。',
      run, readOnly, ({ runId }) => sceneProjectStatus(root, active(runId)));
    tool('scene_project_next', '派发当前一个正式动画段。下一段续接同一作者；优先恢复本地完整响应。',
      run, { ...writeOnce, idempotentHint: false, openWorldHint: true }, ({ runId }) => sceneProjectNext(root, active(runId), true));
    tool('scene_project_recover', '仅登记本机已有的完整正式动画作者响应。',
      run, writeOnce, ({ runId }) => sceneProjectNext(root, active(runId), false));
    tool('scene_project_preview', '待全部段源码保存后统一 Remotion 渲染，并合成原旁白及字幕。',
      run, writeOnce, ({ runId }) => sceneProjectPreview(root, active(runId)));
    tool('scene_project_frames', '查看当前整片预览的关键帧与接缝。帧号从 0 开始，返回实际图像。',
      { ...run, frames: z.array(z.number().int().min(0)).min(1).max(8) },
      writeOnce, ({ runId, frames }) => sceneProjectFrames(root, active(runId), frames), true);
    tool('scene_project_caption_fit', '对已交付视频的画面新版复用纯画面，仅调整原字幕样式位置，保留逐字内容及时间轴。',
      { ...run, previewSha256: sha, marginLeft: z.number().int().min(0).max(360),
        marginRight: z.number().int().min(0).max(360), marginBottom: z.number().int().min(0).max(720) },
      writeOnce, ({ runId, ...input }) => sceneProjectCaptionFit(root, active(runId), input));
    tool('scene_project_export', '给已交付视频的新版预览导出本地 MP4，附真实审看范围。新片沿正式交付入口。',
      { ...run, previewSha256: sha, observations: z.string().min(1).max(5000) }, writeOnce,
      ({ runId, ...input }) => sceneProjectExport(root, active(runId), input));
  }
  if (visualRun) {
    tool('visual_trial_inputs', '读取已交付原片的可选段、真实字幕时间轴和当前 Obsidian 动画参考正文。',
      {}, readOnly, () => visualTrialInputs(root, visualRun));
    tool('visual_trial_generate', '为原片的一段登记你选中的 Obsidian 参考文件名及本片的具体画法，交真实动画作者并用 Remotion 生成同段对照预览。',
      { segment: z.number().int().min(1).max(24), references: z.array(z.string().min(1).max(100)).min(1).max(3),
        design: z.string().trim().min(1).max(6000) },
      { ...writeOnce, openWorldHint: true }, choice => visualTrial(root, visualRun, choice));
    tool('visual_trial_recover', '仅从已保存的完整作者响应恢复本机渲染，不会再次请求作者。',
      {}, writeOnce, () => visualTrial(root, visualRun));
    if (visualRetry) tool('visual_trial_retry', '按明确授权仅重试一次原选段及原画法，优先复用已有完整作者响应。',
      {}, { ...writeOnce, openWorldHint: true }, () => visualTrial(root, visualRun, undefined, visualRetry));
  }
  tool('animation_commit', '核对全部顺序交件及作者身份后生成完整粗剪。',
    { ...run, taskSha256: sha }, writeOnce, async ({ runId, taskSha256 }) => {
      const { segments, creatorEvidence } = await animationDelivery(root, runId);
      return productionApply(root, runId, 'picture', taskSha256, { segments, creatorEvidence });
    });
  tool('earshot_candidates', '在当前粗剪上用原 Earshot bank 渲染实际候选及本地 rank/match/AB，供负责人选择。',
    { ...run, taskSha256: sha, groups: earshotPlanInput }, writeOnce,
    ({ runId, taskSha256, groups }) => earshotCandidates(root, runId, taskSha256, groups));
  tool('earshot_mix', '以负责人明确选中的候选和画面帧执行原生 Earshot/Cinetic 混音与分析。',
    { ...run, taskSha256: sha, candidateKey: sha, input: earshotMixInput }, writeOnce,
    ({ runId, taskSha256, candidateKey, input }) => earshotMix(root, runId, taskSha256, candidateKey, input));
  tool('publication_prepare', '绑定交付成片，准备抖音或 B 站的本地提交包和参数。停止在账号检查和提交之前。',
    { ...run, input: publicationInput }, writeOnce, ({ runId, input }) => publicationPrepare(root, runId, input));

  await server.connect(new StdioServerTransport());
}

try {
  await main();
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
