use crate::models::Project;
use crate::persistence::Database;

use super::AppState;

#[cfg(test)]
impl AppState {
    #[cfg(test)]
    pub fn set_project_for_tests(&self, project: Project) {
        if let Ok(mut guard) = self.project.lock() {
            *guard = Some(project);
        }
    }

    #[cfg(test)]
    pub fn set_database_for_tests(&self, db: Database) {
        if let Ok(mut guard) = self.database.lock() {
            *guard = Some(db);
        }
    }
}
