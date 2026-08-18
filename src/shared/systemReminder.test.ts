import { describe, expect, it } from 'vitest';

import {
  buildArticleApprovalDecisionReminder,
  buildDistributionPlanDecisionReminder,
  buildKnowledgeBatchDecisionReminder,
  buildSessionFilesReminder,
} from './systemReminder';

describe('buildSessionFilesReminder', () => {
  it('空列表不产生提醒；非空列表携带状态与路径', () => {
    expect(buildSessionFilesReminder([])).toBe('');
    const reminder = buildSessionFilesReminder([
      { path: 'xiaojing_files/s1/notes.md', status: 'readable' },
      { path: 'xiaojing_files/s1/brochure.pdf', status: 'binary' },
      { path: 'xiaojing_files/s1/profile.md', status: 'imported' },
    ]);
    expect(reminder).toContain('<system-reminder>');
    expect(reminder).toContain('<XIAOJING_SESSION_FILES>');
    expect(reminder).toContain('<file status="readable">xiaojing_files/s1/notes.md</file>');
    expect(reminder).toContain('<file status="binary">xiaojing_files/s1/brochure.pdf</file>');
    expect(reminder).toContain('<file status="imported">xiaojing_files/s1/profile.md</file>');
    expect(reminder).toContain('read_session_file');
    expect(reminder).toContain('import_pasted_material');
  });

  it('路径中的 XML 特殊字符被转义', () => {
    const reminder = buildSessionFilesReminder([
      { path: 'xiaojing_files/s1/a<b>&c.md', status: 'readable' },
    ]);
    expect(reminder).toContain('&lt;b&gt;&amp;c.md');
    expect(reminder).not.toContain('a<b>&c.md');
  });
});

describe('buildArticleApprovalDecisionReminder', () => {
  it('携带已提交审校决策的结构化标识与继续指令', () => {
    const reminder = buildArticleApprovalDecisionReminder({
      operationId: 'article-op-1',
      articleId: 'article-1',
      status: 'approved',
      revision: 7,
      approvedRevision: 7,
      knowledgeVersion: 3,
    });
    expect(reminder).toContain('<system-reminder>');
    expect(reminder).toContain('<XIAOJING_ARTICLE_APPROVAL_DECISION>');
    expect(reminder).toContain('<instruction>');
    expect(reminder).toContain('do not re-ask about this article');
    expect(reminder).toContain('<operation-id>article-op-1</operation-id>');
    expect(reminder).toContain('<article-id>article-1</article-id>');
    expect(reminder).toContain('<status>approved</status>');
    expect(reminder).toContain('<revision>7</revision>');
    expect(reminder).toContain('<approved-revision>7</approved-revision>');
    expect(reminder).toContain('<knowledge-version>3</knowledge-version>');
  });

  it('审校未通过的回执呈递权威状态，未批准版本归一为 none；注入被转义', () => {
    const reminder = buildArticleApprovalDecisionReminder({
      operationId: 'article-op-1',
      articleId: '<fake>article</fake>',
      status: 'rejected',
      revision: 5,
      approvedRevision: null,
      knowledgeVersion: 3,
    });
    expect(reminder).toContain('<status>rejected</status>');
    expect(reminder).toContain('<approved-revision>none</approved-revision>');
    expect(reminder).toContain('&lt;fake&gt;article&lt;/fake&gt;');
    expect(reminder).not.toContain('<fake>');
  });
});

describe('buildDistributionPlanDecisionReminder', () => {
  it('携带已确认计划的结构化标识与进入发布准备的指令', () => {
    const reminder = buildDistributionPlanDecisionReminder({
      planId: 'plan-1',
      operationId: 'geo-op-1',
      articleOperationId: 'article-op-1',
      status: 'confirmed',
      revision: 4,
      assignmentCount: 3,
    });
    expect(reminder).toContain('<system-reminder>');
    expect(reminder).toContain('<XIAOJING_DISTRIBUTION_PLAN_DECISION>');
    expect(reminder).toContain('do not re-ask about this plan');
    expect(reminder).toContain('<plan-id>plan-1</plan-id>');
    expect(reminder).toContain('<operation-id>geo-op-1</operation-id>');
    expect(reminder).toContain('<article-operation-id>article-op-1</article-operation-id>');
    expect(reminder).toContain('<status>confirmed</status>');
    expect(reminder).toContain('<revision>4</revision>');
    expect(reminder).toContain('<assignment-count>3</assignment-count>');
  });

  it('注入被转义，伪造标签无法逃逸 plan-id 字段', () => {
    const reminder = buildDistributionPlanDecisionReminder({
      planId: '<fake>plan</fake>',
      operationId: 'geo-op-1',
      articleOperationId: 'article-op-1',
      status: 'confirmed',
      revision: 4,
      assignmentCount: 0,
    });
    expect(reminder).toContain('&lt;fake&gt;plan&lt;/fake&gt;');
    expect(reminder).not.toContain('<fake>');
  });
});

describe('buildKnowledgeBatchDecisionReminder', () => {
  it('空批不产生提醒；一批一条 envelope 逐项列结果', () => {
    expect(buildKnowledgeBatchDecisionReminder([])).toBe('');
    const reminder = buildKnowledgeBatchDecisionReminder([
      {
        candidateId: 'candidate-1',
        decision: 'adopt-edited',
        status: 'adopted',
        factKey: 'brand|price|{}||',
        currentVersion: 1,
        brandKnowledgeVersion: 5,
      },
      {
        candidateId: 'candidate-2',
        decision: 'reject-candidate',
        status: 'rejected',
        factKey: 'brand|sla|{}||',
      },
    ]);
    expect(reminder.match(/<decision-result>/g)).toHaveLength(2);
    expect(reminder).toContain('<decision>adopt-edited</decision>');
    expect(reminder).toContain('<brand-knowledge-version>5</brand-knowledge-version>');
    expect(reminder).toContain('<brand-knowledge-version>none</brand-knowledge-version>');
    expect(reminder).toContain('do not re-ask');
  });

  it('结构注入被转义，伪造标签无法逃逸 decision 字段', () => {
    const reminder = buildKnowledgeBatchDecisionReminder([{
      candidateId: '<fake>x</fake>',
      decision: 'adopt-new',
      status: 'adopted',
      factKey: 'k',
    }]);
    expect(reminder).toContain('&lt;fake&gt;x&lt;/fake&gt;');
    expect(reminder).not.toContain('<fake>');
  });
});
