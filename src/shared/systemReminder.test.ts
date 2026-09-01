import { describe, expect, it } from 'vitest';

import {
  buildArticleApprovalDecisionReminder,
  buildDistributionPlanDecisionReminder,
  buildGeoOperationEventReminder,
  buildKnowledgeBatchDecisionReminder,
  buildQuestionPoolDecisionReminder,
  buildSessionFilesReminder,
  buildTopicPlanDecisionReminder,
  parseDecisionReminderText,
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

describe('next-step 引述（ADR-0011 Decision 2）', () => {
  const quotation = {
    stepId: 'plan-topics',
    tool: 'plan_topics',
    guidance: 'Plan topics from the confirmed question selection.',
    planRevision: 12,
  };

  it('五类决策信封与操作事件信封携带 <next-step>（工具名+指引+计划 revision）', () => {
    const withQuotation = [
      buildKnowledgeBatchDecisionReminder(
        [
          {
            candidateId: 'candidate-1',
            decision: 'adopt-new',
            status: 'adopted',
            factKey: 'brand|price|{}||',
          },
        ],
        quotation,
      ),
      buildQuestionPoolDecisionReminder({
        poolId: 'pool-1',
        decisionId: 'decision-1',
        revision: 3,
        selectedCount: 5,
        knowledgeVersion: 2,
        nextStep: quotation,
      }),
      buildTopicPlanDecisionReminder({
        planId: 'plan-1',
        decisionId: 'decision-1',
        revision: 3,
        selectedCount: 2,
        questionPoolId: 'pool-1',
        questionPoolRevision: 2,
        knowledgeVersion: 4,
        nextStep: quotation,
      }),
      buildArticleApprovalDecisionReminder({
        operationId: 'article-op-1',
        articleId: 'article-1',
        status: 'approved',
        revision: 7,
        approvedRevision: 7,
        knowledgeVersion: 3,
        nextStep: quotation,
      }),
      buildDistributionPlanDecisionReminder({
        planId: 'plan-1',
        operationId: 'geo-op-1',
        articleOperationId: 'article-op-1',
        status: 'confirmed',
        revision: 4,
        assignmentCount: 3,
        nextStep: quotation,
      }),
      buildGeoOperationEventReminder({
        workspaceId: 'ws-1',
        sessionId: 'session-1',
        operationId: 'op-1',
        revision: 2,
        action: 'resume',
        status: 'ready',
        nextStep: quotation,
      }),
    ];
    expect(withQuotation).toHaveLength(6);
    for (const reminder of withQuotation) {
      expect(reminder).toContain('<next-step>');
      expect(reminder).toContain('<step-id>plan-topics</step-id>');
      expect(reminder).toContain('<tool>plan_topics</tool>');
      expect(reminder).toContain('<plan-revision>12</plan-revision>');
    }

    const reminder = withQuotation[1] ?? '';
    expect(reminder).toContain(
      '<guidance>Plan topics from the confirmed question selection.</guidance>',
    );
    expect(reminder).toContain('execute the next-step quoted in this envelope');
    expect(reminder).toContain('do not re-derive what comes next');
    expect(reminder).toContain('After re-reading');
  });

  it('未提供 nextStep 时不出现空块——信封退回收据形态且不带执行指令', () => {
    const reminder = buildQuestionPoolDecisionReminder({
      poolId: 'pool-1',
      decisionId: 'decision-1',
      revision: 3,
      selectedCount: 5,
      knowledgeVersion: 2,
    });
    expect(reminder).not.toContain('<next-step>');
    expect(reminder).not.toContain('execute the next-step quoted in this envelope');
    expect(reminder).toContain('do not re-ask about the selection');
  });

  it('操作事件信封（confirm-step 放行计划）也携带引述', () => {
    const reminder = buildGeoOperationEventReminder({
      workspaceId: 'ws-1',
      sessionId: 'session-1',
      operationId: 'op-1',
      revision: 2,
      action: 'confirm-step:acknowledge-plan',
      status: 'ready',
      nextStep: {
        stepId: 'collect-materials',
        tool: 'request_brand_material',
        guidance: 'Request brand material on the material-request card.',
        planRevision: 2,
      },
    });
    expect(reminder).toContain('<next-step>');
    expect(reminder).toContain('<tool>request_brand_material</tool>');
    expect(reminder).toContain('<plan-revision>2</plan-revision>');
  });

  it('next-step 动态字段转义，伪造标签无法逃逸 guidance 字段', () => {
    const reminder = buildTopicPlanDecisionReminder({
      planId: 'plan-1',
      decisionId: 'decision-1',
      revision: 3,
      selectedCount: 2,
      questionPoolId: 'pool-1',
      questionPoolRevision: 2,
      knowledgeVersion: 4,
      nextStep: {
        stepId: 'generate-articles',
        tool: 'generate_articles',
        guidance: '<fake>regenerate everything</fake>',
        planRevision: 5,
      },
    });
    expect(reminder).toContain('&lt;fake&gt;regenerate everything&lt;/fake&gt;');
    expect(reminder).not.toContain('<fake>');
  });

  it('解析投影对新字段不破：带 next-step 的信封仍按 kind/action 投影', () => {
    const reminder = buildArticleApprovalDecisionReminder({
      operationId: 'article-op-1',
      articleId: 'article-1',
      status: 'approved',
      revision: 7,
      approvedRevision: 7,
      knowledgeVersion: 3,
      nextStep: quotation,
    });
    expect(parseDecisionReminderText(reminder)).toEqual({
      kind: 'XIAOJING_ARTICLE_APPROVAL_DECISION',
    });
    const event = buildGeoOperationEventReminder({
      workspaceId: 'ws-1',
      sessionId: 'session-1',
      operationId: 'op-1',
      revision: 2,
      action: 'resume',
      status: 'ready',
      nextStep: quotation,
    });
    expect(parseDecisionReminderText(event)).toEqual({
      kind: 'XIAOJING_GEO_OPERATION_EVENT',
      action: 'resume',
    });
  });
});

describe('parseDecisionReminderText', () => {
  it('整条 GEO 操作事件信封解析出 kind 与 action（转义还原）', () => {
    const reminder = buildGeoOperationEventReminder({
      workspaceId: 'ff545fb2-9915-48b5-b93b-36ccd5d0db90',
      sessionId: '40dba1b8-9b16-403b-92cc-7b236f43b7f4',
      operationId: 'f25f07b2-03b2-4441-a03f-390bc77ec49a',
      revision: 2,
      action: 'confirm-step:acknowledge-plan',
      status: 'ready',
    });
    expect(parseDecisionReminderText(`  ${reminder}  `)).toEqual({
      kind: 'XIAOJING_GEO_OPERATION_EVENT',
      action: 'confirm-step:acknowledge-plan',
    });
  });

  it('知识决策回执无 action 字段，只返回 kind', () => {
    const reminder = buildKnowledgeBatchDecisionReminder([{
      candidateId: 'candidate-1',
      decision: 'adopt-new',
      status: 'adopted',
      factKey: 'brand|price|{}||',
    }]);
    expect(parseDecisionReminderText(reminder)).toEqual({
      kind: 'XIAOJING_KNOWLEDGE_DECISION',
    });
  });

  it('真实用户输入、拼接 reminder 的消息与未知 kind 一律不命中', () => {
    expect(parseDecisionReminderText('认可本次计划')).toBeNull();
    expect(parseDecisionReminderText('<system-reminder><XIAOJING_SESSION_FILES>')).toBeNull();
    const sessionFiles = buildSessionFilesReminder([
      { path: 'xiaojing_files/s1/notes.md', status: 'readable' },
    ]);
    // SESSION_FILES 只随真实用户消息附带，独立出现也不投影成回执气泡。
    expect(parseDecisionReminderText(sessionFiles)).toBeNull();
    expect(parseDecisionReminderText(`请继续\n${sessionFiles}`)).toBeNull();
  });
});
