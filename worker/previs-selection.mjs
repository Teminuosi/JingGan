// assetsOf 返回旧到新的顺序；只在该镜头没有专属版本时才使用全片。
export function selectPrevisClip(clips, shotId) {
  const videos = clips.filter((c) => c.key.endsWith('.mp4'));
  return videos.findLast((c) => c.shotId === shotId)
    ?? videos.findLast((c) => !c.shotId);
}
