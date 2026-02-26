import type { IssueCategory } from './types'

export const textIssueTags = [
  '夸奖密度过高',
  '反馈力度失衡',
  '口语词不自然',
  '文本表达别扭',
  '其他',
] as const

export const ttsIssueTags = [
  '发音错误',
  '断句停顿不合理',
  '重读异常',
  '连读/吞音',
  '语速异常',
  '噪声/毛刺',
  '其他',
] as const

export const feelingOptions = [
  '我能感受到小白的惊讶、好奇、悲伤、和不同程度的鼓励情绪',
  '偶尔能感觉到情绪',
  '整体情绪平稳没什么感觉',
  '其他',
] as const

export const feelingOtherOption = '其他'

export const categoryLabels: Record<IssueCategory, string> = {
  text: '文本问题',
  tts: 'TTS问题',
}
