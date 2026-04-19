/* Shared TypeScript types for Math Analyzer */

export interface QuestionResult {
  question_ref: string;
  topic: string;
  strand: string;
  marks_possible: number;
  marks_awarded: number;
  is_correct: boolean;
  student_answer: string;
  correct_answer: string;
  error_type: string | null;
  error_description: string | null;
}

export interface StudentResult {
  student_name: string;
  student_index: number;
  total_marks_awarded: number;
  total_marks_possible: number;
  percentage: number;
  performance_level: string;
  question_results: QuestionResult[];
  parse_error?: boolean;
  error?: string;
}

export interface QuestionStat {
  question_ref: string;
  topic: string;
  strand: string;
  marks_possible: number;
  class_correct_count: number;
  class_correct_rate: number;
  class_average_marks: number | null;
  common_errors: string[];
  rank?: number;
}

export interface StrandStat {
  strand: string;
  class_average_rate: number;
  questions: string[];
  status: string;
}

export interface ClassAggregated {
  total_students: number;
  valid_students: number;
  class_average: number;
  class_distribution: Record<string, number>;
  student_results: StudentResult[];
  question_stats: QuestionStat[];
  strand_stats: StrandStat[];
  weak_questions: QuestionStat[];
  student_ranking: Array<{
    rank: number;
    student_name: string;
    percentage: number;
    total_marks_awarded: number | string;
    total_marks_possible: number | string;
    performance_level: string;
  }>;
  error?: string;
}

export interface ClassInsights {
  overall_diagnosis: string;
  weak_strand_analysis: Array<{
    strand: string;
    class_average_rate: number;
    key_issues: string[];
    misconception: string;
    curriculum_link: string;
  }>;
  error_type_analysis: {
    conceptual: string;
    procedural: string;
  };
  teaching_recommendations: Array<{
    priority: string;
    strand: string;
    strategy: string;
    activities: string[];
    timeline: string;
  }>;
  attention_students_note: string;
  positive_findings: string;
  parse_error?: boolean;
}

export interface AnswerKeyQuestion {
  question_ref: string;
  topic: string;
  strand: string;
  marks: number | null;
  correct_answer: string;
  solution_method: string;
}

export interface PracticeResult {
  student_name: string;
  grade: string;
  weakness_summary: string;
  practice_questions: Array<{
    question_number: number;
    targeted_weakness: string;
    strand: string;
    topic: string;
    question_type: string;
    question_text: string;
    hints: string;
    solution_steps: string[];
    answer: string;
    explanation: string;
  }>;
  study_tips: string[];
  _gen_type?: string;
  parse_error?: boolean;
}
