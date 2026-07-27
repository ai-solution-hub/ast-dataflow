// Fixture: hand-rolled mutation builder — the .from() return type is an
// inferred structural object literal, not a Supabase generic instantiation.
// The old heuristic's branch 1-b claimed typed from the structural text.
// Expected column-writes hits for table='bid_questions', column='project_id':
//   Line 21 — .insert({ project_id: … })  method='insert'  isTyped=false  confidence='indirect'
function makeDb() {
  return {
    from(_table: string) {
      return {
        insert(_row: { project_id: string }) {
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };
}

const db = makeDb();

async function insertStructural(procurementId: string) {
  return db.from('bid_questions').insert({ project_id: procurementId });
}

export { insertStructural };
