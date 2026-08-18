import { describe, expect, it } from "vitest";

import {
  KEYWORD_MINING_SYSTEM_PROMPT,
  QUESTION_GENERATION_SYSTEM_PROMPT,
  buildKeywordMiningPrompt,
  buildQuestionGenerationPrompt,
  parseMinedKeywords,
  parseQuestionCandidates,
  scoreQuestionPoolCandidate,
} from "./questionPool";

describe("GEO keyword and question-pool contract", () => {
  it("preserves core/scene/longtail categories, regional expansion, and brand filtering", () => {
    const keywords = parseMinedKeywords(
      JSON.stringify({
        core: [
          { term: "成都汽车改装", heat: "高" },
          { term: "鲸跃汽车改装", heat: "high" },
        ],
        scene: [
          { term: "锦江区汽车隔音", heat: "medium" },
          { term: "太古里附近汽车音响升级", heat: "低" },
        ],
        longtail: [{ term: "成都汽车改装店资质怎么看", heat: "low" }],
      }),
      ["鲸跃", "鲸跃汽车"],
    );

    // 品牌词政策（ADR-0006 修正三）：品牌相关词至多保留第一条，不再全滤。
    expect(keywords.map(({ term, category }) => [term, category])).toEqual([
      ["成都汽车改装", "core"],
      ["鲸跃汽车改装", "core"],
      ["锦江区汽车隔音", "scene"],
      ["太古里附近汽车音响升级", "scene"],
      ["成都汽车改装店资质怎么看", "longtail"],
    ]);
    const prompt = buildKeywordMiningPrompt({
      region: "成都",
      allowedRegions: ["成都"],
      industry: "汽车改装",
      productLine: "汽车音响",
      brandNames: ["鲸跃"],
      profileBlock:
        "## 已确认的业务画像（品牌知识中已确认的参考信号）\n- 核心服务（主参考，理解真实服务品类）：主营汽车音响升级",
      libraryKeywords: [
        { term: "成都汽车贴膜", category: "core", heat: "high" },
      ],
    });
    // ADR-0006 修正三：证据纪律、数量指引、增量挖新、品牌词上限、地域条件化。
    expect(prompt).toContain("我在【成都】经营【汽车改装】业务");
    expect(prompt).toContain("【热度证据纪律】");
    expect(prompt).toContain("宁标 low 或不产出");
    expect(prompt).toContain("严禁凭感觉把拼接词标成 high");
    expect(prompt).toContain("已入库词库（不要重复产出；在其之上增量挖掘）");
    expect(prompt).toContain("成都汽车贴膜");
    expect(prompt).toContain("（core）· 4–6 个");
    expect(prompt).toContain("（scene）· 8–12 个");
    expect(prompt).toContain("（longtail）· 12–18 个");
    expect(prompt).toContain("【地域白名单（用户声明的服务范围）】成都");
    expect(prompt).toContain("白名单之外的城市、省份、大区名一律禁止");
    expect(prompt).toContain("直接下辖的】下一级真实地名");
    expect(prompt).toContain("不要只围绕「多少钱/哪家靠谱」造词");
    expect(prompt).toContain("品牌词（至多 1 条）");
    expect(prompt).toContain("鲸跃怎么样");
    expect(prompt).toContain("竞品名永远严禁");
    expect(KEYWORD_MINING_SYSTEM_PROMPT).toContain("搜索词研究专家");
  });

  it("renders the geo-free template when no clean city anchor exists", () => {
    const prompt = buildKeywordMiningPrompt({
      region: "",
      industry: "MES系统实施",
      productLine: "制造业数字化咨询",
      brandNames: ["深蓝智造"],
      profileBlock: "",
    });
    expect(prompt).toContain("服务不限定单一地域/线上或全国交付");
    expect(prompt).toContain("地域按真实用户语言自然呈现");
    expect(prompt).toContain("不强制地域锚，也不得虚构地域");
    expect(prompt).not.toContain("必须包含】「");
    expect(prompt).toContain("深蓝智造怎么样");
  });

  it("keeps a district-scope anchor at district granularity without street fission", () => {
    const prompt = buildKeywordMiningPrompt({
      region: "新都区",
      allowedRegions: ["新都区"],
      industry: "汽车改装",
      productLine: "汽车音响",
      brandNames: [],
      profileBlock: "",
    });
    expect(prompt).toContain("我在【新都区】经营【汽车改装】业务");
    expect(prompt).toContain("【地域白名单（用户声明的服务范围）】新都区");
    expect(prompt).toContain("白名单之外的城市、省份、大区名一律禁止");
    expect(prompt).toContain("区县级服务范围不再向下裂变到街道、乡镇");
    expect(prompt).not.toContain("直接下辖的】下一级真实地名");
  });

  it("filters polluted terms, dedupes the library, and caps brand terms at one", () => {
    // 2026-08 真实事故形态：serviceArea 整段「成都本地，辐射西南地区」被逐字灌入词里。
    const polluted = JSON.stringify({
      core: [
        { term: "成都本地，辐射西南地区汽车音响改装", heat: "high" },
        { term: "成都汽车音响改装", heat: "high" },
        { term: "鲸鱼音响怎么样", heat: "medium" },
        { term: "鲸鱼音响靠谱吗", heat: "low" },
      ],
      scene: [{ term: "成都汽车音响改装", heat: "medium" }],
      longtail: [
        { term: "成都汽车贴膜", heat: "high" },
        { term: "成都汽车音响改装一般多少钱", heat: "high" },
      ],
    });
    const keywords = parseMinedKeywords(polluted, ["鲸鱼音响"], {
      existingTerms: ["成都汽车贴膜"],
    });
    expect(keywords.map((keyword) => keyword.term)).toEqual([
      "成都汽车音响改装",
      "鲸鱼音响怎么样",
      "成都汽车音响改装一般多少钱",
    ]);
    expect(() =>
      parseMinedKeywords(
        JSON.stringify({
          core: [{ term: "成都本地，辐射西南地区汽车音响改装", heat: "high" }],
          scene: [],
          longtail: [],
        }),
        [],
      ),
    ).toThrow("question_pool_empty_keywords");
  });

  it("keeps the question-generation prompt on the js_ai invariant set", () => {
    const keywords = parseMinedKeywords(
      JSON.stringify({
        core: [{ term: "成都汽车改装", heat: "high" }],
        scene: [{ term: "锦江区汽车隔音", heat: "medium" }],
        longtail: [{ term: "成都汽车改装店资质怎么看", heat: "low" }],
      }),
      [],
    );
    const prompt = buildQuestionGenerationPrompt({
      region: "成都",
      industry: "汽车改装",
      keywords,
      existingQuestions: ["成都贴膜哪家好"],
      candidateLimit: 20,
      profileBlock: "## 品牌档案（已确认字段）\n- 行业：汽车改装",
    });
    expect(prompt).toContain("每条问题都必须是一句通顺、口语化的完整中文");
    expect(prompt).toContain("宁可少加东西，也不要拼出半通不通的句子");
    // 推荐尾巴禁令（js_ai 以「绝对禁止」封杀的病句拼接模式）。
    expect(prompt).toContain("【绝对禁止】把「推荐」「哪家好」「找哪家」机械拼接");
    expect(prompt).toContain("每个挖掘词至少转出 1 条问题");
    expect(prompt).toContain("不要套固定句式");
    expect(prompt).toContain("2–3 个曝光价值最高");
    expect(prompt).toContain("品牌档案（已确认字段）");
    expect(prompt).toContain("成都汽车改装●");
    expect(prompt).toContain("锦江区汽车隔音◐");
    expect(prompt).toContain("成都贴膜哪家好");
    expect(prompt).toContain("逐字引用词库");
    expect(QUESTION_GENERATION_SYSTEM_PROMPT).toContain(
      "GEO（生成式引擎优化）用户意图研究员",
    );
  });

  it("fails explicitly when search returns no usable keywords", () => {
    expect(() =>
      parseMinedKeywords('{"core":[],"scene":[],"longtail":[]}', []),
    ).toThrow("question_pool_empty_keywords");
    // 品牌词（单条）现在会被保留，空池改由污染词形触发。
    expect(() =>
      parseMinedKeywords(
        '{"core":[{"term":"成都本地，辐射西南地区汽车改装","heat":"high"}]}',
        [],
      ),
    ).toThrow("question_pool_empty_keywords");
  });

  it("keeps only candidates grounded by at least one exact keyword reference", () => {
    const keywords = parseMinedKeywords(
      '{"core":[{"term":"成都汽车改装","heat":"high"}],"scene":[],"longtail":[]}',
      [],
    );
    const questions = parseQuestionCandidates(
      JSON.stringify({
        questions: [
          {
            text: "成都汽车改装哪家好？",
            recommended: true,
            sourceKeywords: ["成都汽车改装", "编造词"],
          },
          { text: "成都汽车改装哪家好？", sourceKeywords: ["成都汽车改装"] },
          { text: "第二问", sourceKeywords: ["编造词"] },
        ],
      }),
      keywords,
      2,
    );
    expect(questions).toEqual([
      {
        text: "成都汽车改装哪家好？",
        recommended: true,
        sourceKeywords: ["成都汽车改装"],
      },
    ]);

    expect(
      parseQuestionCandidates(
        JSON.stringify({
          questions: [
            { text: "缺少来源" },
            { text: "全部杜撰", sourceKeywords: ["编造词"] },
          ],
        }),
        keywords,
        20,
      ),
    ).toEqual([]);
  });

  it("makes all three PRED-1 factors and 150/100 thresholds traceable", () => {
    const high = scoreQuestionPoolCandidate({
      questionVector: [1, 0],
      knowledgeVector: [1, 0],
      recentSelectedVectors: [[-1, 0]],
    });
    expect(high).toMatchObject({
      relevance: 100,
      recentPoolSimilarity: -100,
      optimizationPotential: 100,
      priorityTotal: 200,
      priority: "high",
      mode: "pred-1",
    });
    expect(high.formula).toContain("high >= 150");
    expect(high.formula).toContain("medium >= 100");

    expect(
      scoreQuestionPoolCandidate({
        questionVector: [1, 0],
        knowledgeVector: [0.5, Math.sqrt(0.75)],
        recentSelectedVectors: [],
      }),
    ).toMatchObject({
      relevance: 50,
      recentPoolSimilarity: 0,
      optimizationPotential: 50,
      priority: "medium",
    });

    expect(
      scoreQuestionPoolCandidate({
        questionVector: [0, 1],
        knowledgeVector: [1, 0],
        recentSelectedVectors: [[0, 1]],
      }),
    ).toMatchObject({
      relevance: 0,
      recentPoolSimilarity: 100,
      optimizationPotential: 0,
      priority: "low",
    });
  });
});
