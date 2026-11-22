
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TEACHER_CODE = Deno.env.get("TEACHER_CODE") ?? "5673";

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers });

async function hash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function teacherAllowed(code: unknown): boolean {
  return typeof code === "string" && code === TEACHER_CODE;
}

function validText(value: unknown, max = 200): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= max;
}

async function getAttempt(id: string, token: string) {
  const tokenHash = await hash(token);

  const { data, error } = await db
    .from("attempts")
    .select("*")
    .eq("id", id)
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function invalidateAttempt(id: string) {
  await db.from("attempts")
    .update({ status: "invalid", invalid_reason: "inactive" })
    .eq("id", id)
    .eq("status", "active");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers });
  }

  if (req.method !== "POST") {
    return response({ error: "Используйте POST" }, 405);
  }

  try {
    const body = await req.json();
    const action = body.action;

    // Получение опубликованных работ для учеников
    if (action === "public_works") {
      const { data, error } = await db
        .from("works")
        .select("id,title,subject,topic,difficulty,duration_minutes")
        .eq("published", true)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return response({ works: data });
    }

    // Создание контрольной или самостоятельной работы
    if (action === "create_work") {
      if (!teacherAllowed(body.teacher_code)) {
        return response({ error: "Неверный код преподавателя" }, 401);
      }

      if (!validText(body.title, 150)) {
        return response({ error: "Укажите название работы" }, 400);
      }

      if (!Array.isArray(body.questions) || body.questions.length === 0) {
        return response({ error: "Добавьте хотя бы одно задание" }, 400);
      }

      const duration = Number(body.duration_minutes);
      if (!Number.isInteger(duration) || duration < 1 || duration > 300) {
        return response({ error: "Некорректная продолжительность" }, 400);
      }

      const questions = body.questions.map((q: any, index: number) => {
        if (!validText(q.text, 3000)) {
          throw new Error(`Некорректный текст задания ${index + 1}`);
        }

        const type = q.type === "written" ? "written" : "test";

        if (type === "test" &&
          (!Array.isArray(q.options) || q.options.length < 2)) {
          throw new Error(`В задании ${index + 1} должно быть не менее двух вариантов`);
        }

        return {
          position: index + 1,
          text: q.text.trim(),
          type,
          options: type === "test" ? q.options : [],
          correct_answer: validText(q.correct_answer, 1000)
            ? q.correct_answer.trim()
            : null,
          points: Math.max(1, Math.min(100, Number(q.points) || 1)),
        };
      });

      const { data: work, error: workError } = await db
        .from("works")
        .insert({
          title: body.title.trim(),
          subject: validText(body.subject, 50) ? body.subject : "Математика",
          topic: validText(body.topic, 150) ? body.topic : null,
          difficulty: validText(body.difficulty, 30) ? body.difficulty : "Средняя",
          duration_minutes: duration,
          published: false,
        })
        .select()
        .single();

      if (workError) throw workError;

      const rows = questions.map((q: any) => ({
        ...q,
        work_id: work.id,
      }));

      const { error: questionsError } = await db
        .from("questions")
        .insert(rows);

      if (questionsError) {
        await db.from("works").delete().eq("id", work.id);
        throw questionsError;
      }

      return response({ success: true, work });
    }

    // Публикация работы
    if (action === "publish_work") {
      if (!teacherAllowed(body.teacher_code)) {
        return response({ error: "Неверный код преподавателя" }, 401);
      }

      if (!validText(body.work_id, 100)) {
        return response({ error: "Не указан ID работы" }, 400);
      }

      const { data, error } = await db
        .from("works")
        .update({ published: Boolean(body.published) })
        .eq("id", body.work_id)
        .select()
        .single();

      if (error) throw error;
      return response({ success: true, work: data });
    }

    // Получение заданий опубликованной работы
    if (action === "get_work") {
      const { data: work, error } = await db
        .from("works")
        .select("id,title,subject,topic,difficulty,duration_minutes")
        .eq("id", body.work_id)
        .eq("published", true)
        .maybeSingle();

      if (error) throw error;
      if (!work) return response({ error: "Работа не найдена" }, 404);

      const { data: questions, error: qError } = await db
        .from("questions")
        .select("id,position,text,type,options,points")
        .eq("work_id", work.id)
        .order("position");

      if (qError) throw qError;

      return response({ work, questions });
    }

    // Начало попытки ученика
    if (action === "start_attempt") {
      if (!validText(body.work_id, 100) ||
          !validText(body.first_name, 60) ||
          !validText(body.last_name, 60)) {
        return response({ error: "Введите имя и фамилию" }, 400);
      }

      const { data: work, error: workError } = await db
        .from("works")
        .select("id,duration_minutes")
        .eq("id", body.work_id)
        .eq("published", true)
        .maybeSingle();

      if (workError) throw workError;
      if (!work) return response({ error: "Работа не найдена" }, 404);

      const token = crypto.randomUUID() + crypto.randomUUID();
      const tokenHash = await hash(token);
      const now = new Date();
      const deadline = new Date(
        now.getTime() + work.duration_minutes * 60_000,
      );

      const { data: attempt, error } = await db
        .from("attempts")
        .insert({
          work_id: work.id,
          first_name: body.first_name.trim(),
          last_name: body.last_name.trim(),
          token_hash: tokenHash,
          status: "active",
          started_at: now.toISOString(),
          deadline_at: deadline.toISOString(),
          last_seen_at: now.toISOString(),
        })
        .select("id,status,started_at,deadline_at")
        .single();

      if (error) throw error;

      return response({
        success: true,
        attempt,
        token,
      });
    }

    // Проверка попытки и обновление активности
    if (action === "heartbeat") {
      if (!validText(body.attempt_id, 100) ||
          !validText(body.token, 200)) {
        return response({ error: "Нет данных попытки" }, 400);
      }

      const attempt = await getAttempt(body.attempt_id, body.token);
      if (!attempt) return response({ error: "Попытка не найдена" }, 404);

      if (attempt.status !== "active") {
        return response({ error: "Попытка уже завершена или аннулирована" }, 409);
      }

      const now = Date.now();
      const lastSeen = new Date(attempt.last_seen_at).getTime();

      if (now - lastSeen > 5000) {
        await invalidateAttempt(attempt.id);
        return response({ error: "Попытка аннулирована из-за потери активности" }, 409);
      }

      if (now > new Date(attempt.deadline_at).getTime()) {
        await db.from("attempts")
          .update({ status: "completed", submitted_at: new Date().toISOString() })
          .eq("id", attempt.id);

        return response({ error: "Время работы истекло" }, 409);
      }

      const { error } = await db.from("attempts")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", attempt.id);

      if (error) throw error;

      return response({
        success: true,
        deadline_at: attempt.deadline_at,
      });
    }

    // Сохранение ответа ученика
    if (action === "save_answer") {
      const attempt = await getAttempt(body.attempt_id, body.token);
      if (!attempt) return response({ error: "Попытка не найдена" }, 404);
      if (attempt.status !== "active") {
        return response({ error: "Попытка не активна" }, 409);
      }

      if (Date.now() > new Date(attempt.deadline_at).getTime()) {
        return response({ error: "Время истекло" }, 409);
      }

      if (!validText(body.question_id, 100) ||
          typeof body.answer !== "string" ||
          body.answer.length > 10000) {
        return response({ error: "Некорректный ответ" }, 400);
      }

      const { error } = await db.from("answers").upsert({
        attempt_id: attempt.id,
        question_id: body.question_id,
        answer: body.answer,
        updated_at: new Date().toISOString(),
      }, { onConflict: "attempt_id,question_id" });

      if (error) throw error;
      return response({ success: true });
    }

    // Завершение попытки
    if (action === "submit_attempt") {
      const attempt = await getAttempt(body.attempt_id, body.token);
      if (!attempt) return response({ error: "Попытка не найдена" }, 404);

      if (attempt.status !== "active") {
        return response({ error: "Попытка уже завершена" }, 409);
      }

      const { error } = await db.from("attempts")
        .update({
          status: "completed",
          submitted_at: new Date().toISOString(),
        })
        .eq("id", attempt.id);

      if (error) throw error;
      return response({ success: true });
    }

    // Просмотр результатов преподавателем
    if (action === "results") {
      if (!teacherAllowed(body.teacher_code)) {
        return response({ error: "Неверный код преподавателя" }, 401);
      }

      const { data: attempts, error } = await db
        .from("attempts")
        .select("id,work_id,first_name,last_name,status,started_at,submitted_at,last_seen_at,invalid_reason")
        .eq("work_id", body.work_id)
        .order("started_at", { ascending: false });

      if (error) throw error;

      return response({ attempts });
    }

    // Ответы конкретного ученика для проверки
    if (action === "attempt_answers") {
      if (!teacherAllowed(body.teacher_code)) {
        return response({ error: "Неверный код преподавателя" }, 401);
      }

      const { data, error } = await db
        .from("answers")
        .select("question_id,answer,updated_at")
        .eq("attempt_id", body.attempt_id);

      if (error) throw error;
      return response({ answers: data });
    }

    return response({ error: "Неизвестное действие" }, 400);
  } catch (error) {
    console.error("MatKlass error:", error);
    return response({
      error: error instanceof Error ? error.message : "Внутренняя ошибка сервера",
    }, 500);
  }
});
