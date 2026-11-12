# -*- coding: utf-8 -*-
"""把「应用价值 / 借鉴价值」写进报名表的案例报告单元格，保留原格式。"""
import copy
import docx
import re

SRC = r'C:\Users\1\WorkBuddy\aicampus\context\报名表\报名表-原始模板.docx'
DST = r'C:\Users\1\WorkBuddy\aicampus\output\报名表\上海科技大学AI赋能行政应用大赛报名表-知枢-v3.docx'

SECTIONS = [
    ('h', '一、应用价值'),
    ('p', '本项目最主要的新增功能是对标库：把兄弟高校学生会、团委的公众号推文采集下来，抽成可比的数据——“别校办过什么、在第几周办、怎么宣传、哪一步出过问题”，从此可查可比，不必靠口耳相传。'),
    ('p', '采集源是公开推文。管理员在微信里关注目标学校的公众号，这份关注列表就是清单；系统按清单读取这些号的新推文，逐篇取正文，先判断是不是活动通知，不是的归档；是的话抽出活动类型、主办方、时间、地点、面向对象、参与方式与宣传形式，按学校、类型、时间入库。原文已删除或无法访问的，保留已抽出的字段并标注失效。首批二十所，清单可随时增删，新增学校当天纳入。'),
    ('p', '库里能做的事很具体：筛“迎新＋晚会”，能看到几所学校分别怎么办、时间卡在开学第几周、哪几家做了直播；勾选三所并排对比；“改期”“场地变更”“活动取消”这类二次通知单独标出，提示核对——别人的坑比自己的教训便宜。老师问“别的学校毕业季怎么做的”，几分钟能出一份带原文链接的简报，不必再去问同学。'),
    ('p', '校内部分是配套的收件台：邮件与转发的消息汇入同一入口，自动打标并抽出截止时间与办理事项；活动立项后按标准流程倒排各阶段截止日并提示撞期；换届时一键导出在办事项与经验条目。'),
    ('p', '跨校采集与对标库是本次新建的重点，也是它区别于一般办公助手的地方；校内收件台沿用团队此前的信息聚合原型。'),

    ('h', '二、使用成效'),
    ('p', '项目尚未进入真实业务周期，不提供估算的节省数据。上线后记录使用人数、周使用频次、采集篇数与抽取准确率、人工纠正率，并与同一批任务的人工耗时对比，用实测替代预期。'),

    ('h', '三、借鉴价值'),
    ('p', '一是换配置不改系统。分类、抽取、待办、提醒与人工复核是通用组件，换成材料报送、活动报名或诉求处理，只改规则与模板，不动代码；别的单位复制的是配置，不是重新开发。'),
    ('p', '二是接入克制。只读接入，不改动原邮箱与群聊，不代替人工审批；对标只取公开推文、注明出处、仅作内部参考，不转载不商用，原文删除或无法访问的自动标注，不绕过限制。'),
    ('p', '三是成本低。模型用国内可直接调用的服务（深度求索、Kimi 等），配开源组件，学生团队自行部署维护，不必立项采购，也不依赖境外接口。'),

    ('h', '四、数据安全'),
    ('p', '按最小必要原则处理：仅取业务所需内容，测试用脱敏或构造样本，凭据加密存放并留操作日志。数据优先本地或校内部署；调用外部模型前核验可否外发并做裁剪。'),
    ('p', 'AI只承担提取与初筛，最终审批与对外发布由授权人员决定。'),
]


def strip_runs(p, text):
    """保留首个 run 的格式，其余删除，然后写入新文本。"""
    runs = p.runs
    if not runs:
        p.add_run(text)
        return
    for r in runs[1:]:
        r._element.getparent().remove(r._element)
    runs[0].text = text


def main():
    d = docx.Document(SRC)
    cell = d.tables[1].rows[0].cells[0]

    paras = cell.paragraphs
    tpl_h = copy.deepcopy(paras[0]._element)
    tpl_p = copy.deepcopy(paras[1]._element)

    for p in list(paras):
        p._element.getparent().remove(p._element)

    for kind, text in SECTIONS:
        el = copy.deepcopy(tpl_h if kind == 'h' else tpl_p)
        cell._tc.append(el)
        new_p = cell.paragraphs[-1]
        strip_runs(new_p, text)

    # 首段若是空段（cell 必须以 p 结尾的规则），清理多余空段
    while len(cell.paragraphs) > 1 and not cell.paragraphs[-1].text.strip():
        cell.paragraphs[-1]._element.getparent().remove(cell.paragraphs[-1]._element)

    import os
    os.makedirs(os.path.dirname(DST), exist_ok=True)
    d.save(DST)

    full = ''.join(cell.text.split())
    print('保存', DST)
    print('案例报告字数（不含空白）:', len(full))
    body = re.sub(r'[一二三四]、[^\n]{0,8}', '', cell.text)
    print('节标题外字数约:', len(''.join(body.split())))
    for line in cell.paragraphs:
        if line.text.strip().startswith(('一、', '二、', '三、', '四、')):
            print('  节:', line.text.strip())


if __name__ == '__main__':
    main()
