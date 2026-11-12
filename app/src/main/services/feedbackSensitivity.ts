import type { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_FEEDBACK_SENSITIVITY,
  feedbackSensitivityMultiplier,
  isFeedbackSensitivityLevel
} from '../../shared/panel'
import type { FeedbackSensitivityLevel } from '../../shared/panel'
import { getSettingOr } from '../db/dao/settingsDao'

/** 灵敏度存在 settings 表，供同步加权链路（关键词、邮件评级）直接读取。 */
function readSensitivity(db: DatabaseSync, key: 'radarSensitivity' | 'keywordSensitivity'): FeedbackSensitivityLevel {
  try {
    const value = getSettingOr<unknown>(db, key, DEFAULT_FEEDBACK_SENSITIVITY)
    return isFeedbackSensitivityLevel(value) ? value : DEFAULT_FEEDBACK_SENSITIVITY
  } catch {
    return DEFAULT_FEEDBACK_SENSITIVITY
  }
}

/** 雷达倍率：面板处置 ±0.35、邮件评级 ±1 都乘以它。 */
export function radarSensitivityGain(db: DatabaseSync): number {
  return feedbackSensitivityMultiplier(readSensitivity(db, 'radarSensitivity'))
}

/** 关键词倍率：邮件/QQ 反馈的基础权重与重复奖励都乘以它。 */
export function keywordSensitivityGain(db: DatabaseSync): number {
  return feedbackSensitivityMultiplier(readSensitivity(db, 'keywordSensitivity'))
}
