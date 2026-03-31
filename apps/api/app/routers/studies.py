from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.db import get_db
from app.schemas import (
    StudyDraftUpdateRequest,
    StudyEventCreateRequest,
    StudySession as StudySessionSchema,
    StudySessionCreateRequest,
    StudySubmissionRequest,
    StudyTask as StudyTaskSchema,
    StudyTaskCreateRequest,
    SurveyResponse,
    SurveyResponseRequest,
)
from app.services.studies import (
    add_study_event,
    create_study_session,
    create_task,
    get_session_by_code_or_404,
    get_task_or_404,
    list_study_sessions,
    list_tasks,
    save_survey,
    submit_session,
    touch_session,
    update_draft,
)


router = APIRouter(prefix="/studies", tags=["studies"])


def _task_schema(task) -> StudyTaskSchema:
    return StudyTaskSchema(
        task_id=task.id,
        title=task.title,
        description=task.description,
        dataset_version_slug=task.dataset_version_slug,
        split=task.split,
        sample_id=task.sample_id,
        default_condition=task.default_condition,
        materials=task.materials_json,
        system_outputs=task.system_outputs_json,
        created_at=task.created_at,
    )


def _session_schema(session, task) -> StudySessionSchema:
    return StudySessionSchema(
        session_id=session.id,
        participant_code=session.participant_code,
        participant_id=session.participant_id,
        task_id=session.task_id,
        study_condition=session.study_condition,
        status=session.status,
        task_title=task.title,
        task_description=task.description,
        materials=task.materials_json,
        system_output=session.system_output,
        draft_output=session.draft_output,
        final_output=session.final_output,
        compile_success=session.compile_success,
        auto_metrics=session.auto_metrics,
        started_at=session.started_at,
        last_active_at=session.last_active_at,
        ended_at=session.ended_at,
    )


@router.get("/tasks", response_model=list[StudyTaskSchema])
def get_tasks(db: Session = Depends(get_db)) -> list[StudyTaskSchema]:
    return [_task_schema(item) for item in list_tasks(db)]


@router.post("/tasks", response_model=StudyTaskSchema)
def create_task_route(
    payload: StudyTaskCreateRequest,
    db: Session = Depends(get_db),
) -> StudyTaskSchema:
    task = create_task(
        db,
        title=payload.title,
        description=payload.description,
        dataset_version_slug=payload.dataset_version_slug,
        split=payload.split,
        sample_id=payload.sample_id,
        default_condition=payload.default_condition,
        system_outputs=payload.system_outputs,
    )
    db.commit()
    return _task_schema(task)


@router.post("/tasks/{task_id}/sessions", response_model=StudySessionSchema)
def create_session_for_task(
    task_id: str,
    payload: StudySessionCreateRequest,
    db: Session = Depends(get_db),
) -> StudySessionSchema:
    try:
        task = get_task_or_404(db, task_id)
        session = create_study_session(
            db,
            task=task,
            participant_id=payload.participant_id,
            study_condition=payload.study_condition,
            participant_code=payload.participant_code,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    db.commit()
    return _session_schema(session, task)


@router.get("/sessions", response_model=list[StudySessionSchema])
def get_sessions(db: Session = Depends(get_db)) -> list[StudySessionSchema]:
    rows = []
    for item in list_study_sessions(db):
        task = get_task_or_404(db, item.task_id)
        rows.append(_session_schema(item, task))
    return rows


@router.get("/participant/{participant_code}", response_model=StudySessionSchema)
def get_participant_session(participant_code: str, db: Session = Depends(get_db)) -> StudySessionSchema:
    try:
        session = get_session_by_code_or_404(db, participant_code)
        task = get_task_or_404(db, session.task_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _session_schema(session, task)


@router.post("/participant/{participant_code}/start", response_model=StudySessionSchema)
def start_participant_session(participant_code: str, db: Session = Depends(get_db)) -> StudySessionSchema:
    try:
        session = get_session_by_code_or_404(db, participant_code)
        task = get_task_or_404(db, session.task_id)
        touch_session(session)
        add_study_event(db, session_id=session.id, event_type="start", payload={})
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    db.commit()
    return _session_schema(session, task)


@router.post("/participant/{participant_code}/events")
def log_participant_event(participant_code: str, payload: StudyEventCreateRequest, db: Session = Depends(get_db)) -> dict[str, bool]:
    try:
        session = get_session_by_code_or_404(db, participant_code)
        add_study_event(db, session_id=session.id, event_type=payload.event_type, payload=payload.payload)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    db.commit()
    return {"ok": True}


@router.post("/participant/{participant_code}/autosave", response_model=StudySessionSchema)
def autosave_participant(participant_code: str, payload: StudyDraftUpdateRequest, db: Session = Depends(get_db)) -> StudySessionSchema:
    try:
        session = get_session_by_code_or_404(db, participant_code)
        task = get_task_or_404(db, session.task_id)
        update_draft(db, session=session, draft_output=payload.draft_output, input_transcript=payload.input_transcript)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    db.commit()
    return _session_schema(session, task)


@router.post("/participant/{participant_code}/submit", response_model=StudySessionSchema)
def submit_participant(participant_code: str, payload: StudySubmissionRequest, db: Session = Depends(get_db)) -> StudySessionSchema:
    try:
        session = get_session_by_code_or_404(db, participant_code)
        task = get_task_or_404(db, session.task_id)
        submit_session(db, session=session, final_output=payload.final_output, input_transcript=payload.input_transcript)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    return _session_schema(session, task)


@router.post("/participant/{participant_code}/survey", response_model=SurveyResponse)
def save_participant_survey(participant_code: str, payload: SurveyResponseRequest, db: Session = Depends(get_db)) -> SurveyResponse:
    try:
        session = get_session_by_code_or_404(db, participant_code)
        response = save_survey(db, session=session, payload=payload.payload)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    db.commit()
    return SurveyResponse(
        study_session_id=response.study_session_id,
        payload=response.payload,
        submitted_at=response.submitted_at,
    )
