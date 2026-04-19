/* Hong Kong Primary School Mathematics Curriculum */

export const CURRICULUM_STRANDS: Record<string, { name_en: string; color: string; topics: Record<string, { grades: string[] }> }> = {
  "數與代數": {
    name_en: "Number and Algebra", color: "#FF6B6B",
    topics: {
      "整數": { grades: ["P1","P2","P3","P4","P5","P6"] },
      "四則運算": { grades: ["P1","P2","P3","P4","P5","P6"] },
      "分數": { grades: ["P3","P4","P5","P6"] },
      "小數": { grades: ["P4","P5","P6"] },
      "百分數": { grades: ["P5","P6"] },
      "負數": { grades: ["P6"] },
      "比": { grades: ["P5","P6"] },
      "代數初步": { grades: ["P5","P6"] },
    },
  },
  "度量": {
    name_en: "Measures", color: "#4ECDC4",
    topics: {
      "長度": { grades: ["P1","P2","P3","P4"] },
      "面積": { grades: ["P3","P4","P5","P6"] },
      "體積與容量": { grades: ["P4","P5","P6"] },
      "重量": { grades: ["P1","P2","P3"] },
      "時間": { grades: ["P1","P2","P3","P4"] },
      "角": { grades: ["P3","P4","P5","P6"] },
      "錢幣": { grades: ["P1","P2","P3"] },
      "速率": { grades: ["P5","P6"] },
    },
  },
  "圖形與空間": {
    name_en: "Shape and Space", color: "#45B7D1",
    topics: {
      "平面圖形": { grades: ["P1","P2","P3","P4","P5","P6"] },
      "立體圖形": { grades: ["P1","P2","P3","P4"] },
      "方向與位置": { grades: ["P1","P2","P3","P4"] },
      "對稱": { grades: ["P3","P4","P5"] },
      "坐標": { grades: ["P5","P6"] },
    },
  },
  "數據處理": {
    name_en: "Data Handling", color: "#96CEB4",
    topics: {
      "統計圖表": { grades: ["P1","P2","P3","P4","P5","P6"] },
      "平均數": { grades: ["P4","P5","P6"] },
      "機會率": { grades: ["P5","P6"] },
    },
  },
};

export const GRADE_LEARNING_OBJECTIVES: Record<string, string[]> = {
  P1: ["認識及書寫100以內的整數","比較及排列100以內整數的大小","100以內的加減法","認識乘法概念（簡單）","認識基本平面圖形（圓形、三角形、四邊形）","認識立體圖形（球、柱、錐）","比較長短、輕重、多少","認識港幣（硬幣和紙幣）","認識時間（時、分、上午、下午）","認識簡單統計圖表（象形圖）","認識前後、左右、上下等方向"],
  P2: ["認識1000以內的整數","1000以內加減法（包括進位和退位）","乘法（2至10的乘數表）","除法入門（等分、包含）","認識二分之一、四分之一","長度（厘米、米）及量度","重量（克、千克）及量度","容量（毫升、升）","認識時間（時、分、秒）","錢幣計算（加減）","認識立體圖形的特性","統計圖表（條形圖）"],
  P3: ["認識10000以內的整數","加減法（四位數）","乘法（兩位數乘一位數）","除法（兩位數除以一位數）","分數的認識（分子、分母）","同分母分數的加減","長度（毫米、千米）的認識","面積的概念（平方厘米）","角的認識（直角、銳角、鈍角）","認識對稱圖形","認識方向（東西南北）","統計圖表（折線圖）"],
  P4: ["大數認識（一百萬以內）","乘法（多位數乘多位數）","除法（多位數除以多位數）","分數（異分母加減）","分數乘法入門","小數的認識（至小數兩位）","小數的加減法","面積（平方米、公頃）","體積與容量","角的度量（量角器）","四邊形性質（平行四邊形、菱形）","平均數","統計圖表（折線圖、圓餅圖）"],
  P5: ["整數四則混合運算","分數四則運算","小數四則運算（至小數三位）","百分數的認識及計算","比的認識","面積（三角形、平行四邊形面積公式）","體積（長方體、正方體）","速率（速度、時間、距離）","坐標的認識","代數初步（簡單方程）","機會率入門","統計的應用"],
  P6: ["負數的認識","整數、小數、分數綜合四則運算","百分數的應用（折扣、稅率、利息）","比例的應用","面積（圓形面積公式）","體積（柱體體積）","速率的綜合應用","代數方程的解法","坐標與圖形變換","統計與機會率綜合應用","數學解題策略"],
};

export function getGradeCurriculum(grade: string): string {
  const objectives = GRADE_LEARNING_OBJECTIVES[grade] || [];
  const strands: string[] = [];
  for (const [name, data] of Object.entries(CURRICULUM_STRANDS)) {
    const topics = Object.entries(data.topics)
      .filter(([, d]) => d.grades.includes(grade))
      .map(([t]) => t);
    if (topics.length) strands.push(`【${name}】${topics.join("、")}`);
  }
  return "課程範疇及主題：\n" + strands.join("\n") + "\n\n主要學習目標：\n" + objectives.map(o => `- ${o}`).join("\n");
}
