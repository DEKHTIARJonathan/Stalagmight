use super::*;
use crate::models::{SectionData, ShotData};

fn numbered_project() -> Project {
    let mut project = Project::new("Numbered synthetic survey".into(), None);
    for lengths in [vec![10.0, 20.0], vec![30.0]] {
        project.add_section(SectionData {
            shots: lengths
                .into_iter()
                .map(|length| ShotData {
                    length,
                    azimuth_in: 90.0,
                    azimuth_out: 90.0,
                    ..ShotData::default()
                })
                .collect(),
            ..SectionData::default()
        });
    }
    project
}

fn numbers(project: &Project) -> Vec<u32> {
    project
        .sections
        .iter()
        .flat_map(|section| section.shots.iter().map(|shot| shot.number.unwrap()))
        .collect()
}

#[test]
fn legacy_numbers_remain_stable_when_direct_save_mints_missing_uuids() {
    let temp = tempfile::TempDir::new().unwrap();
    let mut db = Database::open(&temp.path().join("legacy-numbering.stalx")).unwrap();
    db.save_project(&numbered_project()).unwrap();
    db.conn
        .execute(
            "DELETE FROM project_settings WHERE key = 'shot_numbering'",
            [],
        )
        .unwrap();
    db.conn.execute("UPDATE shots SET uuid = NULL", []).unwrap();
    let legacy = db.load_project().unwrap();
    assert_eq!(numbers(&legacy), vec![1, 2, 3]);
    assert!(legacy
        .sections
        .iter()
        .flat_map(|section| &section.shots)
        .all(|shot| shot.uuid.is_none()));
    db.save_project(&legacy).unwrap();
    let reopened = db.load_project().unwrap();
    assert_eq!(numbers(&reopened), vec![1, 2, 3]);
    assert_eq!(reopened.shot_numbering.next, 4);
    assert!(reopened
        .sections
        .iter()
        .flat_map(|section| &section.shots)
        .all(|shot| shot.uuid.is_some()));
}

#[test]
fn retired_numbers_are_persisted_and_reimport_is_a_new_allocation() {
    let temp = tempfile::TempDir::new().unwrap();
    let mut db = Database::open(&temp.path().join("retired-numbering.stalx")).unwrap();
    let mut project = numbered_project();
    let old_section = project.sections[1].clone();
    project.remove_section(old_section.id).unwrap();
    db.save_project(&project).unwrap();
    let mut reopened = db.load_project().unwrap();
    reopened.add_section(old_section.to_section_data());
    assert_eq!(numbers(&reopened), vec![1, 2, 4]);
    db.save_project(&reopened).unwrap();
    assert_eq!(numbers(&db.load_project().unwrap()), vec![1, 2, 4]);
}
