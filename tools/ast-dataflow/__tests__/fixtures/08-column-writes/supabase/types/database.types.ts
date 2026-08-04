// Miniature of the generated supabase/types/database.types.ts, parsed ad-hoc
// by tools/ast-dataflow/schema.ts so column-writes can tell "no sites" apart
// from "no such table/column". Deliberately NOT in the fixture tsconfig's
// include set (`./*.ts`) — the real generated file is excluded from the root
// tsconfig too, and the parse never needs the type checker.
export type Database = {
  public: {
    Tables: {
      survey_questions: {
        Row: {
          created_at: string;
          id: string;
          project_id: string;
          question_text: string;
        };
        Insert: {
          id?: string;
          insert_only_decoy?: string;
          project_id: string;
          question_text: string;
        };
        Relationships: [];
      };
      bid_projects: {
        Row: {
          id: string;
          owner_id: string;
          title: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
  };
};
