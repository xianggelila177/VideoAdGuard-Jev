export type TypeSafeValue =
  | string
  | number
  | boolean
  | null
  | TypeSafeValue[]
  | { [key: string]: TypeSafeValue };

export type TypeSafeDescription = string | TypeSafeValue[] | { [key: string]: TypeSafeValue };

export interface NoulQuestion {
  type: 'noul';
  instructions: TypeSafeDescription;
  criteria?: {
    true?: TypeSafeDescription;
    false?: TypeSafeDescription;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: TypeSafeDescription;
  criteria: Record<string, TypeSafeDescription | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: TypeSafeDescription;
  criteria: TypeSafeDescription[];
}

export type TypeSafeQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface SystemOneInvokePayload {
  state: TypeSafeValue;
  questions: Record<string, TypeSafeQuestion>;
  model?: string;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type TypeSafeAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneResult {
  model: string;
  answers: Record<string, TypeSafeAnswer>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  requestId?: string;
}

