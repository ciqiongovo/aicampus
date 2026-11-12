/** 邮件独立自定义标签；不包含事项分类、固定话题或关心度。 */
export interface MailTagDefinition {
  id: number
  name: string
  description: string
}
export interface MailTagDefinitionInput {
  name: string
  description?: string
}
