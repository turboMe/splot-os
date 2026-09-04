export * from './video-types.js';
export * from './video-runner.js';
export * from './video-transcribe-tool.js';
export * from './video-cut-tool.js';
export * from './video-audio-tool.js';
export * from './video-remotion-tool.js';
export * from './video-bake-tool.js';
export * from './video-packaging-tool.js';
export * from './video-youtube-upload-tool.js';
export * from './video-intake-tool.js';
export * from './video-storyboard-tool.js';

import { videoTranscribeTool } from './video-transcribe-tool.js';
import { videoGenerateCutsTool, videoRenderCutsTool } from './video-cut-tool.js';
import { videoCleanAudioTool, videoMixAudioTool } from './video-audio-tool.js';
import { videoScaffoldShotTool, videoRenderRemotionTool } from './video-remotion-tool.js';
import { videoBakeMasterTool } from './video-bake-tool.js';
import { videoPackageMetadataTool, videoGenerateThumbnailTool } from './video-packaging-tool.js';
import { videoYoutubeUploadTool } from './video-youtube-upload-tool.js';
import { videoIntakeScanTool } from './video-intake-tool.js';
import { videoGenerateStoryboardTool, videoGetStoryboardTool } from './video-storyboard-tool.js';

export const videoTools = {
  videoIntakeScan: videoIntakeScanTool,
  videoGenerateStoryboard: videoGenerateStoryboardTool,
  videoGetStoryboard: videoGetStoryboardTool,
  videoTranscribe: videoTranscribeTool,
  videoGenerateCuts: videoGenerateCutsTool,
  videoRenderCuts: videoRenderCutsTool,
  videoCleanAudio: videoCleanAudioTool,
  videoMixAudio: videoMixAudioTool,
  videoScaffoldShot: videoScaffoldShotTool,
  videoRenderRemotion: videoRenderRemotionTool,
  videoBakeMaster: videoBakeMasterTool,
  videoPackageMetadata: videoPackageMetadataTool,
  videoGenerateThumbnail: videoGenerateThumbnailTool,
  videoYoutubeUpload: videoYoutubeUploadTool,
};
