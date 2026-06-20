// v8 prompt: structural disambiguation (ครั้งละ vs ครั้ง) + v7 features (2026-06-07)
// ============================================================
//  MedTrack Backend v1.9.2 (Session 11 — Layer 7 Real Refill)
//  - Proxies AI requests to Anthropic Claude API
//  - Keeps ANTHROPIC_API_KEY secure on the server
//  - Rate-limited, CORS-restricted, with logging
//  - PostgreSQL for user/medication/schedule data
//  - LINE webhook for account linking + dose confirmation
//  - Medications CRUD + auto-schedule generation
//  - Cron scheduler for medication reminders via LINE push
//  - Phase 1 Confirmation System (v1.5.0):
//    * Flex Messages with [✅ กินแล้ว] [⏭️ ข้าม] buttons
//    * dose_logs table tracks taken/late/missed/skipped
//  - Phase 2 Caregiver System (v1.6.0):
//    * caregivers table (1 caregiver per user)
//    * /care {code} LINE command for caregiver linking
//    * Escalation cron — alert caregiver after 30 min no confirm
//  - Path B: LINE-based Identity (NEW v1.7.0):
//    * GET /api/users/by-line-id/:lineUserId
//    * POST /api/users/onboard (full profile creation)
//    * Welcome message with onboarding URL
//    * Multi-user support — friend testing ready!
// ============================================================

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const crypto = require('crypto');
const line = require('@line/bot-sdk');
const cron = require('node-cron');

// Phase 2: Caregiver system module
const caregiverModule = require('./caregiver-module');

// ════════════════════════════════════════════════════════════
// PATCH 1 — Prompt v9 (Replace SCAN_MEDICINE_PROMPT_V4)
// ════════════════════════════════════════════════════════════
// HOW TO APPLY:
// 1. Open server.js in GitHub Web UI
// 2. Find line 41: `const SCAN_MEDICINE_PROMPT_V4 = ...`
// 3. Select from that line down to the closing `}\`;` (around line 283)
// 4. Replace with the entire content below (start to end)
// 5. Commit: "feat: prompt v9 - multi-dose + custom_time + ml + frequency_pattern"
// 6. Railway auto-deploys
// ════════════════════════════════════════════════════════════

const SCAN_MEDICINE_PROMPT_V4 = `วิเคราะห์ซองยา/ฉลากยาในภาพนี้ อ่านข้อมูลจาก "ภาพจริง" เท่านั้น ห้ามเดา

═══════════════════════════════════════════════════════
🎯 ภารกิจ: อ่านฉลากยา รพ.รัฐในไทย (สถาบันประสาทวิทยา ฯลฯ)
═══════════════════════════════════════════════════════

📐 โครงสร้างฉลากยา รพ.รัฐไทย (Pattern คงที่):
═══════════════════════════════════════════════════════
ฉลากใช้รูปแบบมาตรฐานเสมอ:
  "วิธีใช้: รับประทาน [ครั้งละ X เม็ด/แคปซูล/มล.] [วันละ N ครั้ง] [timing]"

ตำแหน่งของแต่ละคำเป็นแบบเดียวกันทุกใบ:
  • "ครั้งละ"  → ตามด้วย จำนวนยาต่อมื้อ + หน่วย
                ค่าที่เป็นไปได้: 1, 2, 3, "ครึ่ง", "½", "1/2",
                "หนึ่งส่วนสี่"(=0.25), "สามส่วนสี่"(=0.75)
                🚫 ไม่มีค่า "ครั้ง" (วลี "ครั้งละ ครั้ง" ไม่มีในภาษาไทย)
                
  • "วันละ"   → ตามด้วย จำนวนครั้งต่อวัน + "ครั้ง"
                ค่าที่เป็นไปได้: 1, 2, 3, 4
                
  • timing  → "ก่อนนอน" / "ก่อน/หลังอาหาร[เช้า/เที่ยง/เย็น]" /
              "เวลาปวด" / "ทุก N ชม." / เวลาเฉพาะ (7:30, 11:30...)

═══════════════════════════════════════════════════════
🔴🔴🔴 ขั้นตอนสำคัญ — ห้ามข้าม ห้ามสลับลำดับ
═══════════════════════════════════════════════════════

⭐ STEP 0: ระบุประเภทยา (dose_form) — ทำก่อนทุกอย่าง

   🎯 ระบบ MedTrack รองรับเฉพาะยากิน/ยาน้ำ (oral) เท่านั้น
   ก่อนวิเคราะห์ ตรวจคำสำคัญในฉลากเพื่อระบุประเภทยา:

   ✅ ROUTES ที่รองรับ (ตั้ง dose_form ให้ตรง):
   • "เม็ด" / "tablet" / "tab" / "รับประทาน" → "oral_tablet"
   • "แคปซูล" / "capsule" / "cap" → "oral_capsule"
   • "มล." / "ml" / "ช้อนชา" / "tsp" / "syrup" / "ยาน้ำ" → "oral_syrup"
   • "อมใต้ลิ้น" / "sublingual" / "SL" → "oral_sublingual"
   • "เคี้ยว" / "chew" / "chewable" / "OD" (orodispersible) → "oral_chewable"
   • "เม็ดฟู่" / "ละลายน้ำ" / "effervescent" → "oral_effervescent"

   🚫 ROUTES ที่ "ไม่รองรับ" (ตั้ง dose_form ให้ตรง, ออกเร็ว):
   • "หยอดตา" / "หยด" + "ตา" / "eye drops" / "eye drop" / "ophthalmic" → "eye_drops"
   • "หยอดหู" / "หยด" + "หู" / "ear drops" / "otic" → "ear_drops"
   • "พ่น" / "สูดดม" / "inhaler" / "puff" / "MDI" / "DPI" / "nebulizer" → "inhaler"
   • "ทา" / "ครีม" / "ขี้ผึ้ง" / "เจล" / "cream" / "ointment" / "gel" / "lotion" → "topical"
   • "ฉีด" / "injection" / "SC" / "IM" / "IV" / "insulin" / "unit" (เมื่อหมายถึง IU ยาฉีด) → "injection"
   • "เหน็บ" / "suppository" → "suppository"
   • "พ่นจมูก" / "nasal spray" → "nasal_spray"
   • "vaginal" / "เหน็บช่องคลอด" → "vaginal"

   ⚠️ ถ้าระบุไม่ได้ → "unknown"

   🚨 ถ้า dose_form เป็น non-oral (eye_drops, inhaler, topical, ฯลฯ):
      → ไม่ต้องเดา tablets_per_dose / ml_per_dose (ปล่อย null)
      → ไม่ต้องเดา meal_anchor / meal_relation (ปล่อย "" หรือ null)
      → ใส่ special_instructions ภาษาไทย:
        "⚠️ ระบบยังไม่รองรับยาประเภทนี้ (route=<dose_form>)"
      → ส่ง confidence = 1.0 (มั่นใจว่าเป็น non-oral)
      → ส่ง doses เป็น array ว่าง []
      → ลอก drug_name + hospital_name + dispense_date ปกติ (เผื่อใช้ display)

⭐ STEP 1: ลอกข้อความ "วิธีใช้:" จากซองทั้งหมด
   - อ่านทุกบรรทัด ห้ามตัดคำ
   - ฉลากมักขึ้นบรรทัดใหม่กลางประโยค → อ่านต่อเนื่อง
   - บันทึกใน _debug_label_text
   
   🔍 Checklist — ขณะลอก ให้มองหา 3 ส่วนนี้เสมอ:
   1. ขนาด: "ครั้งละ X เม็ด/แคปซูล/มล."
   2. ความถี่: "วันละ N ครั้ง" / "สัปดาห์ละ..." / "เดือนละ..." /
              "วันเว้นวัน" / "ทุก N วัน" / "ทุก N ชม."
              ⚠️ ถ้ามี "สัปดาห์/อาทิตย์/เดือน" → ไม่ใช่ daily!
   3. timing: "ก่อน/หลังอาหาร[มื้อ]" / "ก่อนนอน" / เวลาเฉพาะ
   → ทั้ง 3 ส่วนเป็นอิสระ ต้องอ่านครบ ห้ามมองข้ามส่วนใด

⭐ STEP 2: ตรวจสอบ vision error (Vision Check)

   📐 2A — ตรวจ "ครั้งละ":
   ฉลากใช้รูปแบบ: "ครั้งละ [จำนวน] เม็ด/แคปซูล/มล."
   
   🚨 ถ้าอ่านได้ "ครั้งละ ครั้ง [เม็ด]" → วลีไม่มีในไทย!
       → ตัว "ครั้ง" ตัวที่ 2 จริง ๆ คือ "ครึ่ง"
       → tablets = 0.5

   📐 2B — ตรวจคำ timing:
   ฉลาก รพ.รัฐใช้คำทางการ: "ก่อนอาหาร" "หลังอาหาร" "ก่อนนอน"
   ❌ ไม่ใช้: "ก่อนกิน" / "หลังกิน" (ภาษาพูด)
   
   🚨 ถ้าอ่านได้ "ก่อนกิน" / "หลังกิน":
       → ตรวจซ้ำ ต้องเป็น "ก่อนนอน" หรือ "ก่อนอาหาร"

⭐ STEP 3: ตัดสิน timing — ลำดับการตรวจ (สำคัญมาก!)
   
   🚨 ใช้ลำดับนี้เคร่งครัด ห้ามสลับ:
   
   3.1 ค้นคำว่า "นอน" (ตัว น+อ+น) ในข้อความ "วิธีใช้:"
       → พบ → timing = "bedtime" (ก่อนนอน)
       → ไปต่อ STEP 4
   
   3.2 ไม่พบ "นอน" → ค้นคำว่า "อาหาร" (ตัว อ+า+ห+า+ร)
       • "หลังอาหารเช้า"  → meal_anchor=breakfast, relation=after
       • "ก่อนอาหารเช้า"  → meal_anchor=breakfast, relation=before
       • "หลังอาหารเที่ยง"→ meal_anchor=lunch, relation=after
       • "ก่อนอาหารเที่ยง"→ meal_anchor=lunch, relation=before
       • "หลังอาหารเย็น"  → meal_anchor=dinner, relation=after
       • "ก่อนอาหารเย็น"  → meal_anchor=dinner, relation=before
       • "หลังอาหาร" (ไม่ระบุมื้อ) → meal_anchor=all, relation=after
       • "ก่อนอาหาร" (ไม่ระบุมื้อ) → meal_anchor=all, relation=before

   🔬🔬 STEP 3.2-CHECK — อ่านคำต่อท้าย "อาหาร" ให้ครบ (สำคัญมาก!):
   ⚠️ ก่อนสรุปว่า "ไม่ระบุมื้อ" (all) — ต้องตรวจตัวอักษร
      ที่อยู่ "ติดกันหลังคำว่าอาหาร" อย่างละเอียดก่อน
   • คำว่า "อาหาร" มักมีมื้อต่อท้าย: อาหาร**เช้า** / อาหาร**เย็น**
   • ตัวอักษรท้าย "เช้า" (เ-ช-้-า) กับ "เย็น" (เ-ย-็-น)
     สั้นและอาจเล็ก/จาง → ห้ามมองข้าม!
   • 🚫 อย่าด่วนสรุป all ถ้ายังไม่แน่ใจว่าไม่มีมื้อต่อท้าย
   • ถ้าซองเขียน "หลังอาหารเช้า" แต่อ่านเร็วเป็น "หลังอาหาร"
     = ตกหล่น! ต้อง zoom ดูตัวอักษรท้ายให้ชัด
   • วิธีตรวจ: อ่านทีละตัวอักษร จากซ้าย→ขวา จนจบบรรทัด
     ไม่ใช่อ่านแบบคร่าว ๆ แล้วเดา
   ✅ สรุป all ได้ "เฉพาะ" เมื่อมั่นใจว่าหลัง "อาหาร"
      ไม่มีตัวอักษรมื้อใด ๆ ต่อท้ายจริง ๆ
   
   🚨🚨 กฎสำคัญ — ระบุมื้อ = ใช้มื้อนั้น (ห้าม generalize):
   • ถ้าฉลากเขียน "เช้า" → meal_anchor=breakfast (ไม่ใช่ all!)
   • ถ้าฉลากเขียน "เที่ยง" → meal_anchor=lunch (ไม่ใช่ all!)
   • ถ้าฉลากเขียน "เย็น" → meal_anchor=dinner (ไม่ใช่ all!)
   • ใช้ all เฉพาะเมื่อฉลาก "ไม่ระบุมื้อ" เท่านั้น

   🚨🚨🚨 MULTI-LINE MEAL DETECTION (สำคัญมาก — เคยพลาด!):
   ฉลากไทยมักขึ้นบรรทัดใหม่สำหรับมื้อ เช่น:
   ┌─────────────────┐
   │ วันละ 1 ครั้ง หลังอาหาร │  ← บรรทัด 1
   │ เช้า                    │  ← บรรทัด 2 (มื้ออยู่บรรทัดถัดไป!)
   └─────────────────┘
   • ถ้าเห็น "หลังอาหาร" หรือ "ก่อนอาหาร" ที่ท้ายบรรทัด
     → ต้องอ่านบรรทัด*ถัดไป*ด้วย! มื้ออาจอยู่บรรทัดใหม่
   • "หลังอาหาร\nเช้า" = "หลังอาหารเช้า" → breakfast (ไม่ใช่ all!)
   • "หลังอาหาร\nเช้า เย็น" → breakfast + dinner (2 doses)

   ⛔ ห้ามใช้ข้ออ้าง "ไม่มั่นใจ → ใช้ all เพื่อความปลอดภัย":
   • ถ้าคุณ "เห็น" คำว่า "เช้า/เที่ยง/เย็น/ก่อนนอน" แล้ว
     = ระบุมื้อชัดเจน → ต้องใช้มื้อนั้น
   • การใช้ all ทั้งที่เห็นมื้อ = ผิด! เพราะ all จะ default breakfast
     ทำให้ผู้ป่วยที่ควรกินเย็น ถูกเตือนเช้าแทน
   • "all เพื่อความปลอดภัย" ไม่ปลอดภัย — มันคือการเดาผิด
   • ถ้าเห็นมื้อชัด → มั่นใจได้เลย ไม่ต้องลังเล
   
   ⛔⛔ ANTI-HALLUCINATION (ห้ามเด็ดขาด):
   • ห้ามใช้ความรู้เรื่องยา (เช่น "PPI กินก่อนอาหาร",
     "Zinc กินหลังอาหาร") มาเปลี่ยน/เพิ่ม timing
   • ตอบตามที่ "ฉลากเขียน" เท่านั้น
   • ถ้าฉลากเขียน "ก่อนอาหารเช้า" → breakfast/before
     ❌ ห้ามเปลี่ยนเป็น all เพราะ "PPI มักกินก่อนอาหารทั่วไป"
   • _debug_timing_reasoning ห้ามมีคำว่า "มัก", "ทั่วไป",
     "เนื่องจากเป็นยา..." → ถ้ามี = คุณกำลัง hallucinate
   
   3.3 ไม่พบทั้ง "นอน" และ "อาหาร" → ตรวจ prn/interval
       • "เวลาปวด" / "เมื่อมีอาการ" → timing = "prn"
       • "ทุก N ชม." → timing = "interval", interval_hours = N
   
   🚨 ป้องกันความสับสน:
   • ถ้าฉลากเขียน "หลังอาหารเช้า" → ❌ ห้ามตอบ bedtime
     (ไม่มีคำว่า "นอน")
   • ถ้าฉลากเขียน "ก่อนนอน" → ❌ ห้ามตอบ meal
     (มีคำว่า "นอน")
   
   ⚠️ จุดที่ AI เคยพลาดในอดีต:
   • "หลังอาหาร" → ตอบเป็น bedtime ผิด!
   • "ก่อนนอน" → ตอบเป็น meal/all/before ผิด!
   → ป้องกันโดยเช็ค "นอน" ก่อน "อาหาร" เสมอ

⭐ STEP 4: ตรวจ "Multi-dose Regimen" (กิน 2 มื้อขึ้นไป)
   
   🔍 รูปแบบ A — ขนาดต่างกันต่อมื้อ (ครั้งละ ซ้ำ):
   • มี "ครั้งละ" ปรากฏซ้ำ 2 ครั้งขึ้นไป
     เช่น "ครั้งละ 2 เม็ด หลังอาหารเช้า ครั้งละ 1 เม็ด หลังอาหารเย็น"
   • มี "X-Y-Z" format (3 ตัวเลขคั่นด้วย -)
     เช่น "0.5-0.5-0.5 เม็ด" = มื้อเช้า/เที่ยง/เย็น
     เช่น "1-0-1 เม็ด" = เช้า 1 / เที่ยง 0 / เย็น 1
   
   🔍 รูปแบบ B — ขนาดเท่ากันทุกมื้อ (วันละ N ครั้ง + ระบุมื้อ):
   ⭐⭐ สำคัญมาก — มักตีความผิด!
   
   รูปแบบ: "ครั้งละ X เม็ด วันละ N ครั้ง หลังอาหาร [มื้อ1 มื้อ2 มื้อ3]"
   เช่น: "ครั้งละ ครึ่ง เม็ด วันละ 3 ครั้ง หลังอาหาร เช้า กลางวัน เย็น"
   
   วิธีตีความ:
   • "ครั้งละ ครึ่ง เม็ด" → ขนาด = 0.5 (เท่ากันทุกมื้อ)
   • "วันละ 3 ครั้ง" → จำนวนมื้อ = 3
   • "เช้า กลางวัน เย็น" → breakfast + lunch + dinner
   → แตกเป็น 3 doses ขนาด 0.5 เท่ากัน

   🚨🚨 กฎกันพลาด (เคยตีความผิด!):
   • "วันละ N ครั้ง" = จำนวนมื้อ ❌ ห้ามเอา N มาเป็นจำนวนเม็ด!
     (เช่น "วันละ 3 ครั้ง" ≠ 3 เม็ด — แต่ = 3 มื้อ)
   • "เช้า กลางวัน เย็น" = 3 มื้อแยก
     ❌ ห้ามเอาแค่มื้อสุดท้าย (เย็น) มื้อเดียว!
   • ขนาดเม็ด มาจาก "ครั้งละ X" เท่านั้น
     ❌ ห้ามเอา "วันละ N" มาเป็นขนาดเม็ด

   📐 mapping ชื่อมื้อ:
   • "เช้า" → breakfast
   • "กลางวัน" / "เที่ยง" → lunch
   • "เย็น" → dinner

   ⚠️ ถ้าตรวจพบ multi-dose (A หรือ B) → output doses[] หลายตัว
       ไม่ใช่ดอส 1 ตัว

⭐ STEP 5: ตรวจ "Custom Time" (เวลาเฉพาะเจาะจง)
   
   🔍 เครื่องบ่งชี้:
   • มีตัวเลขเวลาในฉลาก เช่น "7:30" "11.30 น" "07:00 12:00 17:00"
   • อาจมีคำว่า "ก่อนอาหาร" ร่วมด้วย — เก็บทั้ง 2 ค่า
   
   ✅ ตัวอย่าง:
   "ก่อนอาหาร 7:30, 11:30, 16:00"
   → 3 doses (custom_time=true)
   → time: 07:30, 11:30, 16:00
   → meal_anchor: "all" (ก่อนอาหาร)
   → meal_relation: "before"

⭐ STEP 6: ตรวจ "Liquid (mL)" — ยาน้ำ
   
   🔍 เครื่องบ่งชี้: "มิลลิลิตร" / "มล." / "ml" / "ซีซี" / "cc"
   
   ✅ ตัวอย่าง: "ครั้งละ 5.5 มิลลิลิตร"
   → ml_per_dose = 5.5
   → tablets_per_dose = null

⭐ STEP 7: ตรวจ "Fraction Words" (คำเศษส่วนภาษาไทย)
   
   • "ครึ่ง" / "½" / "1/2" → 0.5
   • "หนึ่งส่วนสี่" / "1/4" / "¼" → 0.25
   • "สามส่วนสี่" / "3/4" / "¾" → 0.75
   • "หนึ่งส่วนสาม" / "1/3" → 0.33
   • "สองส่วนสาม" / "2/3" → 0.67
   • "1 ครึ่ง" / "1½" → 1.5

⭐ STEP 8: ตรวจ "Frequency Pattern" (รูปแบบความถี่) — สำคัญมาก!
   
   🚨🚨 ตรวจ "ความถี่" ก่อนเสมอ — ห้ามข้าม!
   ฉลากอาจเขียนความถี่หลายแบบ (มี/ไม่มีตัวเลขคั่น):
   
   • วันเว้นวัน:
     "วันเว้นวัน" / "วันเว้น 1 วัน" / "every other day" / "qod"
     → frequency_pattern = alternate
   
   • ทุก N วัน:
     "วันเว้น N วัน" / "ทุก N วัน" / "ทุกๆ N วัน"
     → frequency_pattern = every_n_days (interval=N)
   
   • สัปดาห์ละครั้ง (⭐ ระวังมาก — มักพลาด!):
     "สัปดาห์ละครั้ง" / "สัปดาห์ละ 1 ครั้ง" / "อาทิตย์ละครั้ง" /
     "อาทิตย์ละ 1 ครั้ง" / "ทุกสัปดาห์" / "ทุกวัน[จันทร์-อาทิตย์]" /
     "สัปดาห์ละหน" / "weekly" / "once a week"
     → frequency_pattern = weekly
     ⚠️ "สัปดาห์ละ 1 ครั้ง" = weekly (ไม่ใช่ daily!)
        ตัว "1" คือจำนวนครั้ง/สัปดาห์ ไม่ใช่จำนวนเม็ด/วัน
   
   • เดือนละครั้ง:
     "เดือนละครั้ง" / "เดือนละ 1 ครั้ง" / "ทุกเดือน" / "monthly"
     → frequency_pattern = monthly
   
   • ทุกวัน (default):
     ไม่ระบุความถี่ / "ทุกวัน" / "วันละ..." → daily
   
   🚨🚨 กฎกันพลาด (เคย bug — Vitamin D2!):
   • ถ้าเจอ "สัปดาห์ละ" / "อาทิตย์ละ" / "เดือนละ" ที่ใดในฉลาก
     → ต้อง set frequency_pattern ให้ถูก (weekly/monthly)
     → ❌ ห้าม default เป็น daily!
   • คำว่า "สัปดาห์ละ N ครั้ง": N = จำนวนครั้งต่อสัปดาห์
     ❌ ห้ามตีความ N เป็นจำนวนเม็ด หรือ จำนวนมื้อ/วัน
   • ตรวจ "ความถี่" แยกจาก "timing (มื้อ)" — เป็นคนละเรื่อง
     เช่น "ครั้งละ 1 แคปซูล สัปดาห์ละ 1 ครั้ง หลังอาหาร"
     = 1 แคปซูล · weekly · หลังอาหาร (ไม่ใช่ daily!)
   
   🚨 ยา weekly ที่ต้องระวังเป็นพิเศษ (HIGH RISK ถ้ากินทุกวัน):
   • Methotrexate (สัปดาห์ละครั้ง) → ถ้ากินทุกวัน = ตาย
   • Vitamin D2/D3 ขนาดสูง (20,000-60,000 iu สัปดาห์ละครั้ง)
     → ถ้ากินทุกวัน = vitamin D toxicity
   • Alendronate (osteoporosis สัปดาห์ละครั้ง)
   → เจอยากลุ่มนี้ + weekly → ใส่ special_instructions เตือน

   📊 frequency mapping (ใช้นับจำนวน doses[] ต่อวัน):
   • "วันละ 1 ครั้ง" / qd / od → 1 dose/วัน
   • "วันละ 2 ครั้ง" / bid → 2 doses/วัน
   • "วันละ 3 ครั้ง" / tid → 3 doses/วัน
   • "วันละ 4 ครั้ง" / qid → 4 doses/วัน
   
   ⏰ interval_hours mapping (สำหรับยาทุก N ชม.):
   • q4h → ทุก 4 ชม. (6 doses/วัน: 0, 4, 8, 12, 16, 20)
   • q6h → ทุก 6 ชม. (4 doses/วัน: 6, 12, 18, 24)
   • q8h → ทุก 8 ชม. (3 doses/วัน: 6, 14, 22)
   • q12h → ทุก 12 ชม. (2 doses/วัน: 8, 20)
   ⚠️ สำหรับ interval: ใช้ custom_time=true + time ตามคำนวณ

⭐ STEP 9: ตรวจ "High-Alert Drug" (ยาเสี่ยงสูง)
   
   🚨 Auto-flag is_high_alert = true ถ้า drug_name_en ตรง:
   
   Anticoagulant: Warfarin, Heparin, Dabigatran, Apixaban,
                  Rivaroxaban, Edoxaban
   Antiplatelet:  Clopidogrel, Aspirin (high dose)
   Antiepileptic: Phenytoin, Carbamazepine, Lamotrigine,
                  Valproate, Levetiracetam, Topiramate
   Antiparkinson: Levodopa, Levodopa/Carbidopa,
                  Levodopa/Benserazide, Pramipexole
   Antipsychotic: Quetiapine, Olanzapine, Risperidone,
                  Clozapine, Haloperidol
   Chemo:         Methotrexate, Cyclophosphamide
   Lithium:       Lithium
   Insulin:       Insulin (ทุกชนิด)
   Narcotic:      Morphine, Fentanyl, Tramadol, Codeine
   Benzodiazepine: Clonazepam, Lorazepam, Diazepam, Alprazolam,
                  Midazolam, Clobazam (ยาควบคุมพิเศษ — เสี่ยงติด+กดหายใจ)
   
   → drug_class field ให้ใส่ category ที่ตรง
     (anticoagulant, antiplatelet, antiepileptic, antiparkinson,
      antipsychotic, chemo, lithium, insulin, narcotic, benzodiazepine)

⭐ STEP 10: ตรวจ "Special Instructions + Pairing Drugs"
   
   🔍 ลอกข้อความเตือนเพิ่มเติมบนซอง (ที่ไม่ใช่วิธีใช้/ชื่อยา)
   เช่น:
   • "แจ้งแพทย์ก่อนทำฟัน/ผ่าตัด"
   • "หลีกเลี่ยงการบาดเจ็บ"
   • "หากมีภาวะเลือดออก..."
   • "ห้ามดื่มน้ำเกรปฟรุต"
   • "ควรกินคู่ Folic acid"
   
   → special_instructions: เก็บ raw text ทั้งหมด
   → pairing_drugs: array ของชื่อยา (ถ้ามี mention "กินคู่")
   → warnings: array ของข้อเตือน (ถ้าแยกได้)
   → _debug_extra_text: ลอกข้อความเตือนทั้งหมด (สำหรับ debug)

⭐ STEP 11: ทบทวนความสอดคล้องก่อนตอบ — สำคัญมาก

═══════════════════════════════════════════════════════
📚 EXAMPLES — เคสจริงจาก Phase 1
═══════════════════════════════════════════════════════

✅ Ex 1: Warfarin 1mg (single dose, bedtime, half-tablet)
ฉลาก: "ครั้งละ ครึ่ง เม็ด วันละ 1 ครั้ง ก่อนนอน"
{
  "drug_name": "วาร์ฟาริน",
  "drug_name_en": "Warfarin",
  "drug_name_raw": "Warfarin Tab 1 mg (Maforan)",
  "drug_brand": "Maforan",
  "dose_mg": 1,
  "dose_unit": "mg",
  "is_high_alert": true,
  "drug_class": "anticoagulant",
  "special_instructions": "แจ้งแพทย์ก่อนทำฟัน/ผ่าตัด; หลีกเลี่ยงการบาดเจ็บ; หากมีเลือดออก/ไอ/อาเจียน/ปัสสาวะหรืออุจจาระสีดำ ปรึกษาแพทย์",
  "doses": [
    { "slot_order": 1, "meal_anchor": "bedtime", "meal_relation": "",
      "custom_time": false, "time": null,
      "tablets_per_dose": 0.5, "ml_per_dose": null,
      "frequency_pattern": "daily", "frequency_interval": 1 }
  ],
  "_debug_label_text": "ครั้งละ ครึ่ง เม็ด วันละ 1 ครั้ง ก่อนนอน",
  "_debug_timing_reasoning": "เห็น 'ก่อนนอน' → bedtime",
  "_debug_extra_text": "แจ้งแพทย์ล่วงหน้าก่อนทำฟัน/ผ่าตัด..."
}

✅ Ex 2: Lamotrigine (Multi-dose: เช้า 2 / เย็น 1)
ฉลาก: "ครั้งละ 2 เม็ด หลังอาหารเช้า ครั้งละ 1 เม็ด หลังอาหารเย็น"
{
  "drug_name_en": "Lamotrigine",
  "is_high_alert": true,
  "drug_class": "antiepileptic",
  "doses": [
    { "slot_order": 1, "meal_anchor": "breakfast", "meal_relation": "after",
      "custom_time": false, "tablets_per_dose": 2, "frequency_pattern": "daily" },
    { "slot_order": 2, "meal_anchor": "dinner", "meal_relation": "after",
      "custom_time": false, "tablets_per_dose": 1, "frequency_pattern": "daily" }
  ]
}

✅ Ex 2b: Gabapentin (Multi-meal ขนาดเท่ากัน: ครึ่งเม็ด × 3 มื้อ)
ฉลาก: "ครั้งละ ครึ่ง เม็ด วันละ 3 ครั้ง หลังอาหาร เช้า กลางวัน เย็น"
🚨 "วันละ 3 ครั้ง" = 3 มื้อ (ไม่ใช่ 3 เม็ด!)
🚨 "เช้า กลางวัน เย็น" = 3 มื้อแยก (ไม่ใช่เอาแค่เย็น!)
🚨 ขนาดเม็ด = "ครั้งละ ครึ่ง" = 0.5 ทุกมื้อ
{
  "drug_name_en": "Gabapentin",
  "is_high_alert": false,
  "doses": [
    { "slot_order": 1, "meal_anchor": "breakfast", "meal_relation": "after",
      "custom_time": false, "tablets_per_dose": 0.5, "frequency_pattern": "daily" },
    { "slot_order": 2, "meal_anchor": "lunch", "meal_relation": "after",
      "custom_time": false, "tablets_per_dose": 0.5, "frequency_pattern": "daily" },
    { "slot_order": 3, "meal_anchor": "dinner", "meal_relation": "after",
      "custom_time": false, "tablets_per_dose": 0.5, "frequency_pattern": "daily" }
  ],
  "_debug_timing_reasoning": "ครั้งละครึ่ง=0.5 · วันละ 3 ครั้ง หลังอาหาร เช้า/กลางวัน/เย็น → 3 มื้อ ขนาด 0.5 เท่ากัน"
}

✅ Ex 3: Levodopa/Benser (X-Y-Z + custom time + high-alert)
ฉลาก: "ครั้งละ 0.5-0.5-0.5 เม็ด ก่อนอาหาร 7:30 11:30 16:00 น"
{
  "drug_name_en": "Levodopa/Benserazide",
  "drug_name_raw": "Levodopa/Benser. Tab 200/50 mg",
  "is_high_alert": true,
  "drug_class": "antiparkinson",
  "doses": [
    { "slot_order": 1, "meal_anchor": "all", "meal_relation": "before",
      "custom_time": true, "time": "07:30",
      "tablets_per_dose": 0.5, "frequency_pattern": "daily" },
    { "slot_order": 2, "meal_anchor": "all", "meal_relation": "before",
      "custom_time": true, "time": "11:30",
      "tablets_per_dose": 0.5, "frequency_pattern": "daily" },
    { "slot_order": 3, "meal_anchor": "all", "meal_relation": "before",
      "custom_time": true, "time": "16:00",
      "tablets_per_dose": 0.5, "frequency_pattern": "daily" }
  ]
}

✅ Ex 4: Depakine (ยาน้ำ + dual timing)
ฉลาก: "ครั้งละ 5.5 มิลลิลิตร วันละ 2 ครั้ง เช้า-ก่อนนอน"
{
  "drug_name_en": "Sodium valproate",
  "drug_name_raw": "Depakine sol. 200 mg/ml; 60 ml",
  "drug_brand": "Depakine",
  "dose_unit": "mg/ml",
  "is_high_alert": true,
  "drug_class": "antiepileptic",
  "doses": [
    { "slot_order": 1, "meal_anchor": "breakfast", "meal_relation": "",
      "custom_time": false, "tablets_per_dose": null,
      "ml_per_dose": 5.5, "frequency_pattern": "daily" },
    { "slot_order": 2, "meal_anchor": "bedtime", "meal_relation": "",
      "custom_time": false, "tablets_per_dose": null,
      "ml_per_dose": 5.5, "frequency_pattern": "daily" }
  ]
}

✅ Ex 5: Quetiapine (Fraction word)
ฉลาก: "ครั้งละ หนึ่งส่วนสี่ เม็ด ก่อนนอน"
{
  "drug_name_en": "Quetiapine",
  "is_high_alert": true,
  "drug_class": "antipsychotic",
  "doses": [
    { "slot_order": 1, "meal_anchor": "bedtime", "meal_relation": "",
      "custom_time": false, "tablets_per_dose": 0.25,
      "frequency_pattern": "daily" }
  ]
}

✅ Ex 5b: Omeprazole (ระบุมื้อ → breakfast ไม่ใช่ all!)
ฉลาก: "ครั้งละ 1 เม็ด วันละ 1 ครั้ง ก่อนอาหารเช้า"
🚨 ฉลากเขียน "เช้า" → meal_anchor=breakfast (ไม่ใช่ all!)
🚨 ห้ามเปลี่ยนเป็น all เพราะ "PPI กินก่อนอาหารทั่วไป" (hallucination!)
{
  "drug_name_en": "Omeprazole",
  "is_high_alert": false,
  "doses": [
    { "slot_order": 1, "meal_anchor": "breakfast", "meal_relation": "before",
      "custom_time": false, "tablets_per_dose": 1,
      "frequency_pattern": "daily" }
  ],
  "_debug_timing_reasoning": "ไม่พบ 'นอน' → พบ 'ก่อนอาหารเช้า' → breakfast/before"
}

✅ Ex 6: Methotrexate Weekly (Critical high-alert!)
ฉลาก: "ครั้งละ 1 เม็ด สัปดาห์ละครั้ง วันจันทร์ เวลา 8:00"
{
  "drug_name_en": "Methotrexate",
  "is_high_alert": true,
  "drug_class": "chemo",
  "special_instructions": "⚠️ ยาสัปดาห์ละครั้ง ห้ามกินทุกวัน",
  "doses": [
    { "slot_order": 1, "meal_anchor": "custom", "meal_relation": "",
      "custom_time": true, "time": "08:00",
      "tablets_per_dose": 1,
      "frequency_pattern": "weekly", "day_of_week": 1 }
  ]
}

✅ Ex 6b: Vitamin D2 Weekly (สัปดาห์ละ 1 ครั้ง + หลังอาหาร)
ฉลาก: "รับประทานครั้งละ 1 แคปซูล สัปดาห์ละ 1 ครั้ง หลังอาหาร"
🚨🚨 "สัปดาห์ละ 1 ครั้ง" = weekly (ไม่ใช่ daily!)
🚨 "1" = จำนวนครั้ง/สัปดาห์ ไม่ใช่จำนวนเม็ด/วัน
🚨 มีทั้ง frequency (weekly) + timing (หลังอาหาร) — เก็บทั้ง 2
{
  "drug_name_en": "Cholecalciferol",
  "drug_name_raw": "Vitamin D2 (Calciferol) 20,000 iu",
  "dose_mg": 20000,
  "dose_unit": "iu",
  "is_high_alert": false,
  "special_instructions": "⚠️ วิตามินดีขนาดสูง กินสัปดาห์ละครั้ง ห้ามกินทุกวัน",
  "doses": [
    { "slot_order": 1, "meal_anchor": "all", "meal_relation": "after",
      "custom_time": false, "tablets_per_dose": 1,
      "frequency_pattern": "weekly" }
  ],
  "_debug_timing_reasoning": "ครั้งละ 1 แคปซูล · สัปดาห์ละ 1 ครั้ง → weekly · หลังอาหาร(ไม่ระบุมื้อ) → all/after"
}

═══════════════════════════════════════════════════════
🔍 STEP สุดท้าย — SELF-VALIDATION (ตรวจสอบก่อนตอบ!)
═══════════════════════════════════════════════════════
⚠️⚠️⚠️ ก่อน return JSON — ตรวจ 4 จุดนี้ทุกครั้ง ⚠️⚠️⚠️

🔬 CHECK 1 · _debug_label_text vs meal_anchor (สำคัญที่สุด!)
   อ่าน _debug_label_text ที่ตัวเองเพิ่งเขียน
   • ถ้ามีคำว่า "เช้า" → meal_anchor ต้องเป็น "breakfast"
   • ถ้ามีคำว่า "เที่ยง" / "กลางวัน" → meal_anchor ต้องเป็น "lunch"
   • ถ้ามีคำว่า "เย็น" → meal_anchor ต้องเป็น "dinner"
   • ถ้ามีคำว่า "นอน" / "ก่อนนอน" → meal_anchor ต้องเป็น "bedtime"
   • เฉพาะถ้า "หลังอาหาร" หรือ "ก่อนอาหาร" ไม่มีมื้อต่อท้าย → "all"

   🚨🚨 ถ้า debug_label_text มี "เช้า/เที่ยง/เย็น" แต่ meal_anchor = "all"
   → ผิด! แก้ทันทีก่อนตอบ
   → AI ตอบ "all" ทั้งที่อ่านเห็น "เช้า" = bug ใหญ่

   🚨🚨🚨 FUZZY MATCH (สำคัญมาก!) — รับมือ OCR error อักษรไทยคล้ายกัน:
   ────────────────────────────────────────────────────────
   อักษรไทยบางตัวคล้ายกันมาก → AI vision อาจอ่านพลาด
   ถ้า debug_label_text มีอักษรเหล่านี้ตามหลัง "อาหาร"
   ให้ตีความเป็นมื้อใกล้เคียง (ไม่ใช่ fallback to "all"):

   • "เข้า" / "เช้า" / "เ_้า" → breakfast (ข↔ช)
   • "เย็น" / "เ_็น" / "เป็น" → dinner (ย↔ป)
   • "เที่ยง" / "เทียง" / "เที่_ง" → lunch
   • "นอน" / "_อน" / "นอบ" → bedtime (น↔บ)
   • "กลางวัน" / "_ลางวัน" → lunch

   🚫 ห้าม fallback to "all" ถ้ามีอักษรไทยอื่นต่อท้าย "อาหาร"
   เหตุผล: ผู้ป่วยอาจกินยาผิดมื้อ — ถ้าตีความเป็น "all" ขัดกับฉลาก
           จะปลอดภัยกว่าตีความเป็นมื้อเดียวที่ใกล้เคียง

   เฉพาะกรณีนี้ที่ใช้ "all" ได้:
   ✅ "หลังอาหาร" จบประโยค (ไม่มีอักษรไทยตามมา)
   ✅ "ก่อนอาหาร" จบประโยค
   ❌ "หลังอาหารเ_้า" — ต้องตีความเป็น breakfast (ตาม context อ_้า)
   ❌ "หลังอาหารX" (X = อักษรไทยใดๆ) — ต้องเลือกมื้อใกล้เคียง

🔬 CHECK 2 · doses.length vs frequency
   • ถ้า "วันละ 1 ครั้ง" + frequency_pattern="daily"
   → doses ต้องมี 1 ตัว (ไม่ใช่ 3)
   • ถ้า "วันละ 2 ครั้ง" → doses 2 ตัว
   • ถ้า "วันละ 3 ครั้ง" → doses 3 ตัว

🔬 CHECK 3 · meal_anchor consistency กับ frequency
   • ถ้า "วันละ 1 ครั้ง" (1 มื้อ/วัน)
   → meal_anchor ห้ามเป็น "all" (เพราะ all = ทุกมื้อ = 3 มื้อ)
   → ต้องเลือก breakfast/lunch/dinner/bedtime อย่างใดอย่างหนึ่ง
   ยกเว้น: ฉลากเขียน "หลังอาหาร" ลอย ๆ ไม่ระบุมื้อใด → ใช้ "all" ได้
   
🔬 CHECK 4 · doses[].tablets_per_dose ต้องมีค่า
   • ถ้า "ครั้งละ 1 เม็ด" → tablets_per_dose = 1
   • ห้ามเป็น null ถ้าเขียน "เม็ด" ในฉลาก

🔬 CHECK 5 · TABLET QUANTITY DETECTION (สำคัญมาก — Clinical safety!)
   ────────────────────────────────────────────────────────
   อ่าน _debug_label_text ที่ตัวเองเพิ่งเขียน
   ตรวจ pattern "ครั้งละ X เม็ด" และแยก 4 กรณี:

   🎯 Pattern C — "ครั้งละ N เม็ดครึ่ง เม็ด" → N + 0.5 (ตรวจก่อนสุด!)
   • "ครั้งละ 1 เม็ดครึ่ง เม็ด"    → tablets_per_dose = 1.5
   • "ครั้งละ 2 เม็ดครึ่ง เม็ด"    → tablets_per_dose = 2.5
   • "ครั้งละ 1 เม็ดครั้ง เม็ด"    → vision อ่าน "เม็ดครึ่ง" ผิดเป็น "เม็ดครั้ง"
                                     → tablets_per_dose = 1.5
     เหตุผล: "เม็ดครั้ง" ไม่มีในภาษาไทย → ที่ถูกต้องคือ "เม็ดครึ่ง"

   🎯 Pattern D — Symbol "ครั้งละ N½ เม็ด" → N + 0.5
   • "ครั้งละ 1½ เม็ด"             → tablets_per_dose = 1.5
   • "ครั้งละ 1 1/2 เม็ด"          → tablets_per_dose = 1.5
   • "ครั้งละ 2½ เม็ด"             → tablets_per_dose = 2.5

   🎯 Pattern A — "ครั้งละ ครึ่ง เม็ด" → 0.5 (no number before "ครึ่ง")
   • "ครั้งละ ครึ่ง เม็ด"          → tablets_per_dose = 0.5
   • "ครั้งละ ½ เม็ด"               → tablets_per_dose = 0.5
   • "ครั้งละ 1/2 เม็ด"             → tablets_per_dose = 0.5
   • "ครั้งละ 0.5 เม็ด"             → tablets_per_dose = 0.5

   🎯 Pattern B — Vision hallucination "ครั้งละ [N] ครั้ง เม็ด" → 0.5
   • "ครั้งละ ครั้ง เม็ด"           → vision อ่าน "ครึ่ง" ผิดเป็น "ครั้ง"
                                      → tablets_per_dose = 0.5
   • "ครั้งละ 1 ครั้ง เม็ด"         → vision อ่านผิด → 0.5
   • "ครั้งละ 2 ครั้ง เม็ด"         → vision อ่านผิด → 0.5
     เหตุผล: วลี "ครั้งละ X ครั้ง เม็ด" ไม่มีในภาษาไทย
            ที่ถูกต้องคือ "วันละ N ครั้ง" (ที่บรรทัดอื่น)
     ❌ ห้ามสับสนกับ Pattern C — Pattern B ไม่มี "เม็ด" ก่อนคำ "ครั้ง"

   🚨 PRIORITY ORDER (สำคัญมาก):
   ──────────────────
   ตรวจตามลำดับ — หยุดที่ตัวแรกที่ match:
   1. Pattern C: มี "เม็ดครึ่ง" หรือ "เม็ดครั้ง" + "เม็ด" หลังเลข → N + 0.5
   2. Pattern D: มี "½" หรือ "1/2" หลังเลข → N + 0.5
   3. Pattern A: "ครึ่ง" / "½" / "1/2" / "0.5" หน้า "เม็ด" (ไม่มีเลขก่อน) → 0.5
   4. Pattern B: "ครั้ง" หน้า "เม็ด" (vision error) → 0.5
   
   ⚠️ Multi-dose case:
   • "ครั้งละ ครึ่ง เม็ด วันละ 2 ครั้ง"  → doses 2 ตัว ทั้งคู่ tablets = 0.5
   • "ครั้งละ 1 เม็ดครึ่ง เม็ด วันละ 2 ครั้ง" → doses 2 ตัว ทั้งคู่ tablets = 1.5

   🩺 Clinical impact ถ้าผิด:
   • Atorvastatin 40 mg: 0.5 → 1 = ขนาด 2x → myopathy risk
   • Tarlige 10 mg: 0.5 → 2 = ขนาด 4x → severe sedation, falls
   • Topiramate 100 mg: 1.5 → 1 = underdose → seizure breakthrough
   • Topiramate 100 mg: 1.5 → 2 = overdose → cognitive side effects
   → ผิด = ผู้ป่วยอาจอุบัติเหตุ/บาดเจ็บ/seizure

✅ ถ้าผ่านทั้ง 5 check → return JSON
❌ ถ้าไม่ผ่าน → แก้ก่อน return!
   เพราะข้อมูลขัดแย้งกัน = ผู้ป่วยอาจกินยาผิดมื้อ/ผิดขนาด

🔬 CHECK 6 · MEAL ANCHOR SEQUENCE MATCHING (สำคัญ — Multi-dose!)
   ────────────────────────────────────────────────────────
   อ่าน _debug_label_text แล้วหา sequence ของมื้อหลัง "หลังอาหาร" หรือ "ก่อนอาหาร"
   
   📋 Algorithm:
   1. หาคำว่า "หลังอาหาร" หรือ "ก่อนอาหาร" ใน label
   2. อ่านคำต่อมาตามลำดับ — เก็บ list ของมื้อที่เจอ
   3. ตรวจว่า doses[].meal_anchor ตรงกับ list ในลำดับเดียวกัน

   📝 ตัวอย่าง:
   • "หลังอาหาร เช้า เย็น"            → doses = [breakfast, dinner]
   • "หลังอาหาร เช้า กลางวัน เย็น"    → doses = [breakfast, lunch, dinner]
   • "หลังอาหาร เช้า เที่ยง เย็น"     → doses = [breakfast, lunch, dinner]
   • "หลังอาหาร เช้า ก่อนนอน"         → doses = [breakfast, bedtime]
   • "ก่อนอาหาร เช้า เย็น"            → doses = [breakfast, dinner]
                                          meal_relation = "before"

   🚨 RULE:
   • ลำดับ doses ต้องเรียงตาม label (ไม่ใช่เรียง alphabetical)
   • ถ้า label ว่า "เช้า เย็น" → dose[0]=breakfast, dose[1]=dinner
   • ถ้า dose[0]=dinner และ dose[1]=dinner ทั้งที่ label เป็น "เช้า เย็น"
     → ❌ ผิด! ต้องแก้เป็น breakfast + dinner
   
   🎯 Counter-example (อย่าพลาด):
   • label = "หลังอาหาร เช้า เย็น" (ครั้งละ 1 เม็ด วันละ 2 ครั้ง)
     ❌ doses = [{meal_anchor: "dinner"}, {meal_anchor: "dinner"}]  ผิด
     ✅ doses = [{meal_anchor: "breakfast"}, {meal_anchor: "dinner"}] ถูก
   
   🩺 Clinical impact:
   • Topiramate: ถ้า map "เช้า เย็น" → "dinner+dinner" → ขาดยาเช้า → seizure
   • Carbamazepine: ถ้า map 3 มื้อผิด → blood level ไม่คงที่

═══════════════════════════════════════════════════════
🕐 CUSTOM TIME DETECTION (สำหรับเวลาเฉพาะแบบ X.XX / X:XX / X น.)
═══════════════════════════════════════════════════════
ถ้า _debug_label_text มีตัวเลขในรูป "เวลา" (HH.MM / HH:MM / HH น.)
→ ใช้ custom_time = true + time = "HH:MM"

📋 Patterns:
• "X.XX" (ทศนิยม 2 ตำแหน่ง) ไม่มีหน่วย mg/ml/มก/มล ตามมา
  → ตีเป็นเวลา ถ้า X อยู่ในช่วง 0-23 และ XX อยู่ในช่วง 0-59
  เช่น "6.00", "18.30", "08.00"

• "X:XX" → ตีเป็นเวลาทันที
  เช่น "6:00", "18:30"

• "X น." / "X.XX น." → ตีเป็นเวลาทันที (ภาษาไทย)
  เช่น "6 น.", "18.00 น."

🎯 ตัวอย่าง:
• "ครั้งละ 1 เม็ด 6.00"
  → 1 dose · custom_time=true · time="06:00"
  → meal_anchor = "all" (ไม่มีมื้อ)
  → tablets_per_dose = 1

• "ครั้งละ 1 เม็ด 6.00 18.00"
  → 2 doses · custom_time=true · time=["06:00", "18:00"]
  → meal_anchor = "all"

• "ครั้งละ 1 เม็ด หลังอาหารเช้า 8.00 น."
  → 1 dose · meal_anchor=breakfast · custom_time=true · time="08:00"
  → (ทั้ง meal_anchor + custom_time)

⚠️ False positive ที่ต้องกัน:
• "2.00 mg" / "5.50 ml" / "ขนาด 6.00 mg" → ไม่ใช่เวลา (เพราะมีหน่วย)
• "Lot 6.00" / "Page 6.00" → ไม่ใช่เวลา (ดู context)
• "ทศนิยม 24+" เช่น "25.00" → ไม่ใช่เวลา (เกิน 24 ชม.)

🩺 Clinical impact:
• ReQUIP PD (Parkinson's): เวลาคงที่สำคัญ — Parkinson's ต้องการ steady level
• ยา Sinemet: ใช้ custom_time เพื่อ on-off pattern
• ยา Methotrexate: weekly + เวลาเฉพาะ

═══════════════════════════════════════════════════════
🔤 drug_name_en — INN (International Nonproprietary Name)
═══════════════════════════════════════════════════════
ใส่เฉพาะ INN ใน drug_name (ไทย) และ drug_name_en (อังกฤษ)
ลบ trade name ออก — เก็บ trade name แยกใน drug_brand

ตัวอย่าง INN translation:
วาร์ฟาริน → Warfarin
ฟีโนไฟเบรต → Fenofibrate
โอเมพราโซล → Omeprazole
แอสไพริน → Aspirin
ทราโซโดน → Trazodone
กาบาเพนติน → Gabapentin
ลอราซีแปม → Lorazepam
โลซาร์แทน → Losartan
ลาโมทริจีน → Lamotrigine
ลีโวโดปา → Levodopa
เบนเซอราไซด์ → Benserazide
คาร์บิโดปา → Carbidopa
โซเดียมวัลโปรเอต → Sodium valproate
ควีไทอาปีน → Quetiapine
เมโทเทรกเซต → Methotrexate
โคลนาซีแปม → Clonazepam
ลอราซีแปม → Lorazepam
ไดอาซีแปม → Diazepam
อัลปราโซแลม → Alprazolam
โคลบาแซม → Clobazam

⚠️ Trade names ที่พบบ่อย (ลบออกจาก drug_name_en เก็บใน drug_brand):
Lexemin, Maforan, Miracid, Ativan, TraZODeL, Depakine, 
Lamoga, Levomet, Sinemet, Madopar

drug_name_raw: ลอกตามซองเป๊ะ (ไม่ normalize ไม่แปล)
  เช่น "Warfarin Tab 1 mg (Maforan)" → คงไว้ทั้งหมด

═══════════════════════════════════════════════════════
📅 dispense_date: พ.ศ. → ค.ศ. (ลบ 543)
═══════════════════════════════════════════════════════
04/06/2569 → 2026-06-04

═══════════════════════════════════════════════════════
🔒 ความปลอดภัย
═══════════════════════════════════════════════════════
- อ่านไม่ชัด → null (ห้ามเดา)
- ห้ามใช้ความรู้ภายนอกซองเติมข้อมูล
- tablets/ml/timing ผิด = อันตราย

═══════════════════════════════════════════════════════
📤 OUTPUT JSON เท่านั้น (Schema v2):
═══════════════════════════════════════════════════════
{
  "drug_name": "",
  "drug_name_en": "",
  "drug_name_raw": "",
  "drug_brand": "",
  "dose_form": "",
  "dose_mg": null,
  "dose_unit": "mg",
  "is_high_alert": false,
  "drug_class": "",
  "special_instructions": "",
  "pairing_drugs": [],
  "warnings": [],
  "doses": [
    {
      "slot_order": 1,
      "meal_anchor": "",
      "meal_relation": "",
      "custom_time": false,
      "time": null,
      "tablets_per_dose": null,
      "ml_per_dose": null,
      "frequency_pattern": "daily",
      "frequency_interval": 1,
      "day_of_week": null,
      "day_of_month": null
    }
  ],
  "total_quantity": null,
  "patient_name": "",
  "hospital_name": "",
  "dispense_date": "",
  "confidence": 0.0,
  "_debug_label_text": "",
  "_debug_timing_reasoning": "",
  "_debug_extra_text": ""
}`;

const app = express();
const PORT = process.env.PORT || 3000;

// ── Trust proxy (Railway/Cloudflare put us behind a reverse proxy) ──
// Without this, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
// when it sees the X-Forwarded-For header → request crashes → 502.
// '1' = trust the first proxy hop (Railway's edge).
app.set('trust proxy', 1);

// ── Config from env ──────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const ALLOWED_ORIGINS = (
process.env.ALLOWED_ORIGINS ||
'https://medtrackq.com,https://www.medtrackq.com,https://app.medtrackq.com,https://medtrackq.github.io,http://localhost:3000,http://127.0.0.1:5500'
).split(',').map(s => s.trim());

// Scheduler controls
const SCHEDULER_ENABLED = process.env.SCHEDULER_ENABLED !== 'false';  // default ON
const PUSH_QUOTA_MONTHLY = parseInt(process.env.PUSH_QUOTA_MONTHLY || '500');  // LINE free plan
const PUSH_QUOTA_SAFETY_MARGIN = parseInt(process.env.PUSH_QUOTA_SAFETY_MARGIN || '50');

if (!ANTHROPIC_API_KEY) {
  console.error('❌ FATAL: ANTHROPIC_API_KEY environment variable is missing');
  process.exit(1);
}

if (!DATABASE_URL) {
  console.error('❌ FATAL: DATABASE_URL environment variable is missing');
  console.error('   Railway auto-provides this when you link a PostgreSQL service.');
  process.exit(1);
}

// LINE is optional — if not set, webhook endpoint will return helpful error
if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
  console.warn('⚠️  LINE_CHANNEL_ACCESS_TOKEN or LINE_CHANNEL_SECRET not set');
  console.warn('   /webhook/line will return 500 until these are configured');
  console.warn('   Scheduler push will be disabled');
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── LINE SDK Client (only if configured) ─────────────────────
const lineClient = (LINE_CHANNEL_ACCESS_TOKEN && LINE_CHANNEL_SECRET)
  ? new line.Client({
      channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
      channelSecret: LINE_CHANNEL_SECRET,
    })
  : null;

// ── PostgreSQL Connection Pool ───────────────────────────────
const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Railway requires this
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

db.on('error', (err) => {
  console.error('❌ Unexpected PostgreSQL error:', err);
});

// ── Auto-Migration: สร้าง tables ถ้ายังไม่มี ──
async function runMigrations() {
  console.log('🔍 Checking database schema...');
  
  // Check if users table exists (proxy for "schema initialized")
  const check = await db.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'users'
    ) AS exists
  `);
  
  if (!check.rows[0].exists) {
    console.log('📦 Running initial migration...');
    
    // ── Create tables (using IF NOT EXISTS for safety) ──
    const migrationSQL = `
      -- TABLE 1: users
      CREATE TABLE IF NOT EXISTS users (
        id                  SERIAL PRIMARY KEY,
        line_user_id        VARCHAR(50) UNIQUE,
        name                VARCHAR(100),
        phone               VARCHAR(20),
        age                 INTEGER,
        gender              VARCHAR(10),
        breakfast_time      TIME DEFAULT '07:00',
        lunch_time          TIME DEFAULT '12:00',
        dinner_time         TIME DEFAULT '18:00',
        bedtime             TIME DEFAULT '21:00',
        timezone            VARCHAR(50) DEFAULT 'Asia/Bangkok',
        push_lead_minutes   INTEGER DEFAULT 0,
        link_token          VARCHAR(100) UNIQUE,
        link_expires_at     TIMESTAMP,
        created_at          TIMESTAMP DEFAULT NOW(),
        updated_at          TIMESTAMP DEFAULT NOW(),
        deleted_at          TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_users_line_user_id ON users(line_user_id) WHERE deleted_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_users_link_token ON users(link_token) WHERE link_token IS NOT NULL;
      
      -- TABLE 2: medications
      CREATE TABLE IF NOT EXISTS medications (
        id                  SERIAL PRIMARY KEY,
        user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        drug_name           VARCHAR(200) NOT NULL,
        drug_name_en        VARCHAR(200),
        dose_mg             DECIMAL(10,2),
        dose_unit           VARCHAR(20) DEFAULT 'mg',
        tablets_per_dose    INTEGER DEFAULT 1,
        frequency_per_day   INTEGER,
        timing_type         VARCHAR(20),
        total_tablets       INTEGER,
        total_days          INTEGER,
        doctor_name         VARCHAR(100),
        hospital_name       VARCHAR(100),
        dispense_date       DATE,
        is_active           BOOLEAN DEFAULT TRUE,
        paused_until        DATE,
        created_at          TIMESTAMP DEFAULT NOW(),
        updated_at          TIMESTAMP DEFAULT NOW(),
        deleted_at          TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_medications_user ON medications(user_id) WHERE is_active = TRUE;
      
      -- TABLE 3: dose_schedules
      CREATE TABLE IF NOT EXISTS dose_schedules (
        id              SERIAL PRIMARY KEY,
        medication_id   INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reminder_time   TIME NOT NULL,
        meal_anchor     VARCHAR(20),
        meal_relation   VARCHAR(20),
        start_date      DATE NOT NULL DEFAULT CURRENT_DATE,
        end_date        DATE,
        is_active       BOOLEAN DEFAULT TRUE,
        created_at      TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_schedules_time ON dose_schedules(reminder_time) WHERE is_active = TRUE;
      CREATE INDEX IF NOT EXISTS idx_schedules_user ON dose_schedules(user_id);
      CREATE INDEX IF NOT EXISTS idx_schedules_med ON dose_schedules(medication_id);
      
      -- TABLE 4: push_logs
      CREATE TABLE IF NOT EXISTS push_logs (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        schedule_ids    INTEGER[],
        scheduled_for   TIMESTAMP NOT NULL,
        sent_at         TIMESTAMP,
        status          VARCHAR(20) DEFAULT 'pending',
        error_message   TEXT,
        created_at      TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_push_logs_scheduled ON push_logs(scheduled_for, status);
      CREATE INDEX IF NOT EXISTS idx_push_logs_user ON push_logs(user_id);
      
      -- Trigger: auto-update updated_at
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `;
    
    await db.query(migrationSQL);
    
    // Create triggers separately (CREATE TRIGGER can't be in same string with $$ easily)
    await db.query(`DROP TRIGGER IF EXISTS users_updated_at ON users`);
    await db.query(`CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);
    await db.query(`DROP TRIGGER IF EXISTS medications_updated_at ON medications`);
    await db.query(`CREATE TRIGGER medications_updated_at BEFORE UPDATE ON medications FOR EACH ROW EXECUTE FUNCTION set_updated_at()`);
    
    console.log('✅ Initial migration complete: 4 tables created');
  } else {
    console.log('✅ Schema already initialized (users table found)');
  }
  
  // ── Additive migrations (idempotent — safe to run every startup) ──
  console.log('🔧 Running additive migrations...');
  
  // v1.4.0: add push_lead_minutes column (for existing databases from v1.3.0)
  await db.query(`
    ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS push_lead_minutes INTEGER DEFAULT 0
  `);
  
  // v1.4.0: add deleted_at column to medications for soft delete (if not present)
  await db.query(`
    ALTER TABLE medications 
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP
  `);
  
  // v1.9.x: drug name detail + high-alert columns (idempotent — ปลอดภัยถ้ามีอยู่แล้ว)
  await db.query(`
    ALTER TABLE medications
    ADD COLUMN IF NOT EXISTS drug_name_raw VARCHAR(300),
    ADD COLUMN IF NOT EXISTS drug_brand VARCHAR(100),
    ADD COLUMN IF NOT EXISTS is_high_alert BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS drug_class VARCHAR(100)
  `);
  
  console.log('✅ Additive migrations complete');
}

// Test DB connection + run migrations on startup
(async () => {
  try {
    const r = await db.query('SELECT NOW()');
    console.log('✅ PostgreSQL connected at:', r.rows[0].now);
    
    await runMigrations();
    
    // Start scheduler after DB is ready
    if (SCHEDULER_ENABLED && lineClient) {
      startScheduler();
      startMissedDoseCron();  // Phase 1: Auto-mark missed doses every 5 min
      caregiverModule.startCaregiverEscalationCron(db, lineClient, cron);  // Phase 2: Alert caregivers
      startAppointmentReminderCron();  // Phase 5: LINE reminders 7/3/1 days before
    } else {
      console.warn('⚠️  Scheduler disabled (SCHEDULER_ENABLED=false or LINE not configured)');
    }
  } catch (err) {
    console.error('❌ Database setup failed:', err.message);
    console.error('   Stack:', err.stack);
    process.exit(1);
  }
})();

// ── Middleware ───────────────────────────────────────────────
// Capture raw body for LINE webhook signature verification
app.use(express.json({
  limit: '15mb',
  verify: (req, _res, buf) => {
    // Store raw body only for LINE webhook endpoint
    if (req.originalUrl === '/webhook/line') {
      req.rawBody = buf.toString('utf8');
    }
  }
}));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

app.use(cors({
  origin: (origin, cb) => {
    // Allow no-origin (curl / mobile app) and whitelisted origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    console.warn('[CORS] blocked origin:', origin);
    cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  credentials: false,
}));

// ── Rate limiting: 30 req/min/IP for AI endpoints ────────────
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,  // 30→60: batch test ส่งหลายใบ + super-tester scan พร้อมกัน
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit', message: 'Too many requests. Please wait a minute.' },
});

// ── Simple request logger (no secrets) ───────────────────────
app.use((req, _res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path} origin=${req.headers.origin || '-'}`);
  next();
});

// ============================================================
//  HEALTH CHECK
// ============================================================
app.get('/', (_req, res) => {
  res.json({
    service: 'medtrack-backend',
    status: 'ok',
    version: '1.4.2',
    scheduler: SCHEDULER_ENABLED && lineClient ? 'active' : 'disabled',
    time: new Date().toISOString(),
  });
});

app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ 
      status: 'ok',
      version: '1.10.0',
      build_date: '2026-05-04-v4-login',
      features: {
        dedup_medications: true,
        dedup_by_english_name: true,
        ai_force_english_name: true,
        line_login: !!process.env.LINE_LOGIN_CHANNEL_ID,
        multi_caregiver: true,
        admin_dashboard: true,
        diagnostics_export: true,
        today_via_schedules: true
      },
      db: 'connected',
      scheduler: SCHEDULER_ENABLED && lineClient ? 'active' : 'disabled',
      time: new Date().toISOString() 
    });
  } catch (e) {
    res.status(503).json({ 
      status: 'degraded', 
      db: 'disconnected',
      error: e.message,
      time: new Date().toISOString() 
    });
  }
});

// ============================================================
//  HELPER: call Claude with an image + prompt, expect JSON back
// ============================================================
async function callClaudeVisionJSON({ imageBase64, mediaType, prompt, maxTokens = 1000 }) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: maxTokens,
    temperature: 0,
    system: [
      {
        type: 'text',
        text: SCAN_MEDICINE_PROMPT_V4,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  const rawText = (msg.content?.[0]?.text || '').trim();

  // [cache-monitor] log cache hit/miss for scan-medicine
  const u = msg.usage || {};
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheCreate = u.cache_creation_input_tokens || 0;
  const input = u.input_tokens || 0;
  const status = cacheRead > 0 ? 'HIT' : (cacheCreate > 0 ? 'WRITE' : 'MISS');
  console.log(`[scan-cache] ${status} · read=${cacheRead} · write=${cacheCreate} · input=${input} · output=${u.output_tokens || 0}`);

  // ── Robust JSON extraction ──
  // AI อาจใส่: markdown fences, ข้อความนำหน้า/ตามหลัง, หรือ JSON ถูกตัด
  // วิธีแก้: (1) ลบ fences (2) ดึงจาก { แรก ถึง } สุดท้าย (3) parse
  let parsed;
  function tryParse(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  // ลอง 1: parse ตรง ๆ (กรณีปกติ)
  let cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  parsed = tryParse(cleaned);

  // ลอง 2: ดึงจาก { แรก ถึง } สุดท้าย (ตัดข้อความนำหน้า/ตามหลัง)
  if (!parsed) {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const extracted = cleaned.slice(firstBrace, lastBrace + 1);
      parsed = tryParse(extracted);
    }
  }

  // ลอง 3: ถ้ายังไม่ได้ — JSON อาจถูกตัดกลางคัน (maxTokens หมด)
  // ลองปิด bracket ที่ค้าง (best-effort)
  if (!parsed) {
    const firstBrace = cleaned.indexOf('{');
    if (firstBrace !== -1) {
      let frag = cleaned.slice(firstBrace);
      // นับ { } ที่ยังไม่ปิด แล้วเติม } ให้ครบ
      const opens = (frag.match(/{/g) || []).length;
      const closes = (frag.match(/}/g) || []).length;
      if (opens > closes) {
        // ตัด trailing comma + เติม } ที่ขาด
        frag = frag.replace(/,\s*$/, '') + '}'.repeat(opens - closes);
        parsed = tryParse(frag);
      }
    }
  }

  if (!parsed) {
    const err = new Error('ai_response_not_json');
    err.rawText = rawText;
    console.error('[ai_response_not_json] raw (first 300):', rawText.slice(0, 300));
    throw err;
  }
  return { parsed, rawText, usage: msg.usage };
}

// ============================================================
//  POST-PROCESSOR: Tablet Quantity Mapping Correction
//  Safety net for AI map fail — comprehensive half-tablet detection
//
//  Patterns supported (priority order — most specific first):
//    C. "ครั้งละ N เม็ดครึ่ง/เม็ดครั้ง เม็ด" → N + 0.5 (e.g., Topiramate 1.5)
//    D. "ครั้งละ N½ เม็ด" / "ครั้งละ N 1/2 เม็ด" → N + 0.5 (symbols)
//    A. "ครั้งละ ครึ่ง/½/1/2/0.5 เม็ด" → 0.5 (explicit half)
//    B. "ครั้งละ [N] ครั้ง เม็ด" → 0.5 (vision hallucination)
//
//  Test cases verified: Atorvastatin, Donepezil, Tarlige, Levetiracetam,
//                       Topiramate (1 เม็ดครึ่ง = 1.5)
// ============================================================
function detectTabletQuantity(labelText) {
  if (!labelText) return null;
  
  // Pattern C: "ครั้งละ N เม็ดครึ่ง/เม็ดครั้ง เม็ด" → N + 0.5
  // e.g., "ครั้งละ 1 เม็ดครึ่ง เม็ด" → 1.5
  //       "ครั้งละ 2 เม็ดครั้ง เม็ด" → 2.5 (vision error of "เม็ดครึ่ง")
  const patternC = /ครั้งละ\s*(\d+)\s*เม็ด(ครึ่ง|ครั้ง)\s+เม็ด/;
  const matchC = labelText.match(patternC);
  if (matchC) {
    const baseN = parseInt(matchC[1]);
    return {
      value: baseN + 0.5,
      pattern: matchC[2] === 'ครั้ง' ? 'C-vision-error' : 'C-explicit',
      matched: matchC[0]
    };
  }
  
  // Pattern D: "ครั้งละ N½ เม็ด" / "ครั้งละ N 1/2 เม็ด" → N + 0.5
  // e.g., "ครั้งละ 1½ เม็ด" → 1.5
  //       "ครั้งละ 1 1/2 เม็ด" → 1.5
  const patternD = /ครั้งละ\s*(\d+)\s*(½|1\/2)\s*เม็ด/;
  const matchD = labelText.match(patternD);
  if (matchD) {
    const baseN = parseInt(matchD[1]);
    return {
      value: baseN + 0.5,
      pattern: 'D-symbol',
      matched: matchD[0]
    };
  }
  
  // Pattern A: "ครั้งละ ครึ่ง/½/1/2/0.5 เม็ด" → 0.5
  // Must NOT match if preceded by digit (caught by C/D above)
  const patternA = /ครั้งละ\s+(ครึ่ง|½|1\/2|0\.5)\s*เม็ด/;
  const matchA = labelText.match(patternA);
  if (matchA) {
    return {
      value: 0.5,
      pattern: 'A-explicit',
      matched: matchA[0]
    };
  }
  
  // Pattern B: "ครั้งละ [N] ครั้ง เม็ด" → 0.5 (vision hallucinate ครึ่ง→ครั้ง)
  // Vision misread "ครึ่ง" as "ครั้ง" (similar Thai characters)
  // Excludes Pattern C ("เม็ดครั้ง" already caught above)
  const patternB = /ครั้งละ\s+(\d+\s+)?ครั้ง\s+เม็ด/;
  const matchB = labelText.match(patternB);
  if (matchB) {
    return {
      value: 0.5,
      pattern: 'B-vision-error',
      matched: matchB[0]
    };
  }
  
  return null; // No half-tablet pattern detected → leave AI output unchanged
}

function correctHalfTabletMapping(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const labelText = (parsed._debug_label_text || '').trim();
  if (!labelText) return parsed;

  const detected = detectTabletQuantity(labelText);
  if (!detected) return parsed; // No pattern → unchanged

  const targetValue = detected.value;
  const pattern = detected.pattern;

  if (!Array.isArray(parsed.doses)) return parsed;
  
  let corrected = 0;
  parsed.doses.forEach((d, idx) => {
    const before = d.tablets_per_dose;
    if (before !== targetValue) {
      d.tablets_per_dose = targetValue;
      corrected++;
      console.log(`[half-tab-check] Corrected dose[${idx}].tablets_per_dose: ${before} → ${targetValue} (pattern: ${pattern}, matched: "${detected.matched}")`);
    }
  });

  if (corrected > 0) {
    parsed._post_processor_applied = parsed._post_processor_applied || [];
    parsed._post_processor_applied.push({
      rule: 'tablet_quantity_correction',
      pattern: pattern,
      target_value: targetValue,
      doses_corrected: corrected,
      label_excerpt: labelText.slice(0, 100),
      matched_text: detected.matched,
      timestamp: new Date().toISOString()
    });
  }

  return parsed;
}

// ============================================================
//  POST-PROCESSOR: Meal Anchor Sequence Correction
//  Issue [1] — AI maps multi-dose meal_anchor incorrectly
//  Example: label "หลังอาหาร เช้า เย็น" → doses [dinner, dinner] ❌
//           ควรเป็น [breakfast, dinner]
//
//  Strategy: extract meal sequence from label, validate doses order
// ============================================================
function correctMealAnchorMapping(parsed) {
  if (!parsed || !Array.isArray(parsed.doses) || parsed.doses.length === 0) return parsed;
  const labelText = (parsed._debug_label_text || '').trim();
  if (!labelText) return parsed;

  // Skip if custom_time present — explicit time overrides meal_anchor inference
  const hasCustomTime = parsed.doses.some(d => d.custom_time === true);
  if (hasCustomTime) return parsed;

  // Find meal sequence after "หลังอาหาร" or "ก่อนอาหาร"
  // Stop at end-of-string or keywords that mark next section
  const afterMealMatch = labelText.match(
    /(?:หลังอาหาร|ก่อนอาหาร)\s+([\u0E00-\u0E7E\s\d.:น]+?)(?:$|(?:วันละ|สัปดาห์|เดือน|รับประทาน|หรือ|พร้อม|ก่อน|หลัง)\s*[^อ])/
  );
  if (!afterMealMatch) return parsed;

  const mealSection = afterMealMatch[1];

  // Extract meal keywords in order of appearance
  const mealKeywords = [
    { keyword: 'เช้า',     anchor: 'breakfast' },
    { keyword: 'เที่ยง',    anchor: 'lunch' },
    { keyword: 'กลางวัน',   anchor: 'lunch' },
    { keyword: 'เย็น',      anchor: 'dinner' },
    { keyword: 'ก่อนนอน',   anchor: 'bedtime' },
  ];

  const found = [];
  mealKeywords.forEach(mk => {
    let idx = mealSection.indexOf(mk.keyword);
    while (idx !== -1) {
      // Skip 'นอน' inside 'ก่อนนอน' to avoid double-counting
      if (mk.keyword === 'นอน' && idx > 0 && mealSection[idx - 1] !== 'น') {
        // it's standalone 'นอน' — but unlikely without "ก่อน" prefix in Thai labels
      }
      found.push({ anchor: mk.anchor, idx });
      idx = mealSection.indexOf(mk.keyword, idx + mk.keyword.length);
    }
  });
  found.sort((a, b) => a.idx - b.idx);

  // Deduplicate adjacent (e.g., "เที่ยง" + "กลางวัน" both → lunch)
  const labelSequence = [];
  found.forEach(f => {
    if (labelSequence.length === 0 || labelSequence[labelSequence.length - 1] !== f.anchor) {
      labelSequence.push(f.anchor);
    }
  });

  if (labelSequence.length === 0) return parsed;

  // Only correct if label sequence length matches doses count
  // (avoid risky fix when uncertain)
  if (labelSequence.length !== parsed.doses.length) return parsed;

  // Check if any dose has wrong meal_anchor
  let needsCorrection = false;
  parsed.doses.forEach((d, i) => {
    if (d.meal_anchor !== labelSequence[i]) needsCorrection = true;
  });
  if (!needsCorrection) return parsed;

  // Apply correction
  let corrected = 0;
  const before = parsed.doses.map(d => d.meal_anchor).join(',');
  parsed.doses.forEach((d, i) => {
    if (d.meal_anchor !== labelSequence[i]) {
      console.log(`[meal-anchor-fix] dose[${i}].meal_anchor: ${d.meal_anchor} → ${labelSequence[i]}`);
      d.meal_anchor = labelSequence[i];
      d.slot_order = i + 1;
      corrected++;
    }
  });

  parsed._post_processor_applied = parsed._post_processor_applied || [];
  parsed._post_processor_applied.push({
    rule: 'meal_anchor_sequence_correction',
    label_sequence: labelSequence.join(','),
    before: before,
    after: parsed.doses.map(d => d.meal_anchor).join(','),
    doses_corrected: corrected,
    timestamp: new Date().toISOString()
  });

  return parsed;
}

// ============================================================
//  POST-PROCESSOR: Custom Time Detection
//  Issue [4] — AI doesn't recognize "6.00" / "18.00" as time
//  Example: label "ครั้งละ 1 เม็ด 6.00" → custom_time=true, time="06:00"
//
//  Patterns:
//    A. "X.XX" (decimal 2 digits) — NOT followed by mg/ml unit
//    B. "X:XX" — colon separator
//    C. "X.XX น." / "X น." — Thai time marker
// ============================================================
function detectAndApplyCustomTime(parsed) {
  if (!parsed || !Array.isArray(parsed.doses) || parsed.doses.length === 0) return parsed;
  const labelText = (parsed._debug_label_text || '').trim();
  if (!labelText) return parsed;

  // Skip if AI already set custom_time (trust AI's explicit decision)
  const hasCustomTime = parsed.doses.some(d => d.custom_time === true);
  if (hasCustomTime) return parsed;

  const found = [];
  const matchedRanges = []; // track positions to avoid double-matching

  // Pattern A: "X.XX" decimal — must NOT be followed by mg/ml/มก/มล/cc
  // Use negative lookahead to exclude unit
  const patA = /(?:^|[^\d.\d])(\d{1,2})\.(\d{2})(?!\d)(?!\s*(?:mg|ml|มก|มล|กรัม|cc|ลิตร|เม็ด))/g;
  let m;
  while ((m = patA.exec(labelText)) !== null) {
    const h = parseInt(m[1]);
    const min = parseInt(m[2]);
    if (h <= 23 && min <= 59) {
      const time = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
      const start = m.index + (m[0].startsWith(m[1]) ? 0 : 1);
      const end = start + m[1].length + 1 + m[2].length;
      if (!matchedRanges.some(r => start < r.end && end > r.start)) {
        found.push({ time, hour: h, minute: min, raw: `${m[1]}.${m[2]}`, start, end });
        matchedRanges.push({ start, end });
      }
    }
  }

  // Pattern B: "X:XX" colon
  const patB = /(\d{1,2}):(\d{2})/g;
  while ((m = patB.exec(labelText)) !== null) {
    const h = parseInt(m[1]);
    const min = parseInt(m[2]);
    if (h <= 23 && min <= 59) {
      const time = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
      const start = m.index;
      const end = start + m[0].length;
      if (!matchedRanges.some(r => start < r.end && end > r.start)) {
        found.push({ time, hour: h, minute: min, raw: m[0], start, end });
        matchedRanges.push({ start, end });
      }
    }
  }

  if (found.length === 0) return parsed;

  // Sort by position in label (preserve order)
  found.sort((a, b) => a.start - b.start);

  // Decision: apply 1:1, expand doses, or skip
  if (found.length === parsed.doses.length) {
    // 1:1 mapping — apply to existing doses
    parsed.doses.forEach((d, i) => {
      d.custom_time = true;
      d.time = found[i].time;
      d.slot_order = i + 1;
    });
    console.log(`[custom-time] 1:1 mapping — ${found.map(f => f.time).join(',')}`);
  } else if (found.length > 1 && parsed.doses.length === 1) {
    // Single dose but multiple times → expand
    const template = parsed.doses[0];
    parsed.doses = found.map((f, i) => ({
      ...JSON.parse(JSON.stringify(template)),
      slot_order: i + 1,
      custom_time: true,
      time: f.time
    }));
    console.log(`[custom-time] expanded 1 → ${found.length} doses with times ${found.map(f => f.time).join(',')}`);
  } else if (found.length === 1 && parsed.doses.length === 1) {
    // Single time, single dose
    parsed.doses[0].custom_time = true;
    parsed.doses[0].time = found[0].time;
    console.log(`[custom-time] single time ${found[0].time}`);
  } else {
    // Mismatch — skip to avoid wrong assignment
    console.log(`[custom-time] skip — found=${found.length} times, doses=${parsed.doses.length} (no clear mapping)`);
    return parsed;
  }

  parsed._post_processor_applied = parsed._post_processor_applied || [];
  parsed._post_processor_applied.push({
    rule: 'custom_time_detection',
    times_detected: found.map(f => f.time).join(','),
    doses_count: parsed.doses.length,
    timestamp: new Date().toISOString()
  });

  return parsed;
}

// ============================================================
//  ORCHESTRATOR: Run all post-processors in priority order
// ============================================================
function applyAllPostProcessors(parsed) {
  if (!parsed) return parsed;
  parsed = correctHalfTabletMapping(parsed);     // P5: tablet quantity
  parsed = detectAndApplyCustomTime(parsed);     // P6: custom time
  parsed = correctMealAnchorMapping(parsed);     // P6: meal anchor sequence
  return parsed;
}

// ============================================================
//  ENDPOINT 1 — SCAN APPOINTMENT (v2 prompt)
// ============================================================
app.post('/api/scan-appointment', aiLimiter, async (req, res) => {
  const { image_base64, media_type } = req.body || {};
  if (!image_base64) return res.status(400).json({ error: 'missing_image', message: 'image_base64 is required' });

  const mediaType = media_type || 'image/jpeg';

  const prompt = `คุณเป็น AI ผู้เชี่ยวชาญในการอ่านใบนัดแพทย์ของโรงพยาบาลในประเทศไทย
ภารกิจของคุณ: ดึงข้อมูล 9 ฟิลด์อย่างครบถ้วนจากภาพใบนัด

═══════════════════════════════════════════════
🎯 PHILOSOPHY (สำคัญที่สุด — อ่านก่อน):
═══════════════════════════════════════════════

ใบนัดแพทย์ในไทย = แบบฟอร์มมาตรฐาน
มี label (เช่น "ชื่อแพทย์") + value (เช่น "นพ.พรเทพ")

หน้าที่ของคุณ:
1. ✅ "หาทุก label" ในเอกสาร (ชื่อแพทย์, ชื่อผู้ป่วย, คลินิก, ฯลฯ)
2. ✅ อ่าน "value" ที่อยู่ติดกับแต่ละ label
3. ✅ ใส่ลงในฟิลด์ JSON ที่ตรงกัน

❌ ห้าม skip: ถ้าเห็น label "ชื่อแพทย์" + value ที่ติดกัน
   = ต้องใส่ doctor_name (ห้ามใส่ "")

❌ ห้ามเดา: ถ้า value ถูก black-out จริง
   = ใส่ "" (empty string)

✅ เป้าหมาย: extract ทุกฟิลด์ที่อ่านได้จริง
   ไม่ใช่ "ปลอดภัย" แต่ "ครบถ้วน"

═══════════════════════════════════════════════
📋 STEP-BY-STEP WORKFLOW:
═══════════════════════════════════════════════

ขั้นที่ 1: Scan ทั้งเอกสาร
  - อ่านทั้งภาพ ทั้งคอลัมน์ซ้ายและขวา
  - ใบนัดไทยมัก 2-column layout
  - ห้ามอ่านแค่บนหรือซ้าย

ขั้นที่ 2: หา Labels (คำกำกับ)
  Labels ที่ต้องหา:
    "คลินิก" / "แผนก"
    "ชื่อผู้ป่วย" / "ผู้ป่วย"
    "เลขที่นัด" / "เลขใบนัด"
    "สถานที่" / "อาคาร"
    "วันที่นัด" / "Next Appointment"
    "วันที่ออกใบนัด" / "Issue Date"
    "HN" / "เลขผู้ป่วย"
    "ชื่อแพทย์" / "แพทย์" / "ผู้ตรวจ"
    "ผู้ออกบัตรนัด" / "ผู้บันทึก"

ขั้นที่ 3: อ่าน Value ที่ติดกับ Label
  - Value มักอยู่ "ขวาของ label" หรือ "ใต้ label"
  - บางใบ: label-value แบบตาราง (column based)

ขั้นที่ 4: Map ให้ตรงฟิลด์ JSON
  - "ชื่อแพทย์" → doctor_name
  - "ชื่อผู้ป่วย" → patient_name
  - "คลินิก" → department
  - ฯลฯ

ขั้นที่ 5: Self-check
  ก่อนตอบ ถามตัวเอง:
    "ผมเห็น label 'ชื่อแพทย์' มั้ย?"
       ถ้าเห็น → ใส่ value ที่ติด
       ถ้าไม่เห็น/blackout → ""
    
    "ผมเห็น label 'ชื่อผู้ป่วย' มั้ย?"
    "ผมเห็น label 'คลินิก' มั้ย?"
    
    ตอบทุก label ที่ต้องหา

═══════════════════════════════════════════════
📚 ตัวอย่างจริง (Few-shot Examples):
═══════════════════════════════════════════════

ตัวอย่าง 1: ใบนัด Sikarin Hospital (โครงสร้างเทมเพลต)

Layout (จริง):
┌──────────────────────────┬──────────────────────────┐
│ คลินิก: เวชปฏิบัติ       │ วันที่ออกใบนัด: 25/02/2569│
│ ชื่อผู้ป่วย: นาย อภิเดช ป.│ HN: 44051354             │
│ เลขที่นัด: 6720283       │ ชื่อแพทย์: นพ.พรเทพ ว.   │
│ สถานที่: อาคาร...        │                          │
│ วันที่นัด: 17/06/2569    │                          │
└──────────────────────────┴──────────────────────────┘

ผู้ออกบัตรนัด: PAMMEE PN ← ไม่ใช่ doctor!

Output (ที่ถูกต้อง):
{
  "doctor_name": "นพ.พรเทพ วีรโรจน์",
  "department": "เวชปฏิบัติ",
  "hospital_name": "Sikarin Hospital",
  "building": "อาคารประกันสังคม ชั้น 1",
  "date_str": "17/06/2569",
  "date_iso": "2026-06-17",
  "time_str": "13:00-16:00",
  "hn": "44051354",
  "patient_name": "นาย อภิเดช ประทุมศิริ",
  "instructions": ["..."],
  "note": "",
  "confidence": 0.85
}

ตัวอย่าง 2: ใบนัดที่ doctor field ถูก black-out

Layout:
  ชื่อแพทย์: ███████ (blacked out)

Output:
{
  "doctor_name": "",  ← ใส่ "" เพราะ blacked out จริง
  ...
}

═══════════════════════════════════════════════
⚠️ FIELD-SPECIFIC RULES:
═══════════════════════════════════════════════

1️⃣ doctor_name (ชื่อแพทย์):
   หาภายใต้ label: "ชื่อแพทย์", "แพทย์", "ผู้ตรวจ", "Doctor"
   ขึ้นต้นด้วย: "นพ.", "พญ.", "ศ.นพ.", "รศ.พญ.", "Dr.", "ดร."
   
   ⚠️ อย่านำ:
   ❌ "ผู้ออกบัตรนัด" / "ผู้บันทึก" / "ผู้พิมพ์"
   ❌ ชื่อภาษาอังกฤษล้วน (เช่น "PAMMEE PN") = เจ้าหน้าที่
   
   ⚠️ Sikarin format: ชื่อแพทย์อยู่ "ขวาบน" ติดกับ HN
   
   ✅ ถ้าเห็น label "ชื่อแพทย์" + ตัวอักษร → ใส่!

2️⃣ patient_name (ชื่อผู้ป่วย):
   หาภายใต้ label: "ชื่อผู้ป่วย", "ชื่อ-นามสกุล", "ผู้ป่วย"
   มีคำนำหน้า: "นาย/นาง/น.ส./เด็กชาย/ด.ช./เด็กหญิง/ด.ญ."
   
   ✅ ถ้าเห็น label + ชื่อ → ใส่ทันที
   ❌ ห้ามใส่ชื่อหมอเป็น patient_name

3️⃣ department (คลินิก/แผนก):
   หาภายใต้ label: "คลินิก", "แผนก", "Clinic", "Department"
   ตัวอย่างค่า:
     ✅ "เวชปฏิบัติ"
     ✅ "อายุรกรรม"
     ✅ "ศัลยกรรม"
     ✅ "โรคหัวใจ"
     ✅ "เบาหวานและต่อมไร้ท่อ"
   
   ✅ ถ้าเห็น label "คลินิก" + value → ใส่!

4️⃣ hospital_name:
   อ่านตัวอักษรที่ปรากฏจริง — ห้าม auto-correct
   ❌ "Sikarin" → ตอบ "Siam" (ผิด!)
   ❌ "Bumrungrad" → ตอบ "Bangrak" (ผิด!)

5️⃣ hn:
   เลขใต้ label "HN" หรือ "เลขผู้ป่วย"
   อ่านทีละหลัก (ระวัง 0/6/8, 1/7, 3/5)
   มัก 6-8 หลัก
   
   ❌ ห้ามใช้:
     - "เลขที่นัด" (queue number)
     - วันที่ในรูปเลข

6️⃣ date_iso:
   วันที่ผู้ป่วย "ต้องมาพบแพทย์ครั้งถัดไป"
   ❌ ไม่ใช่ "วันที่ออกใบนัด" (issue date)
   📅 พ.ศ. → ค.ศ.: ปี = พ.ศ. - 543
       17/06/2569 → "2026-06-17"

7️⃣ time_str:
   เวลานัด เช่น "13:00-16:00", "09:00 น."

8️⃣ building:
   อาคาร/ชั้น/ห้อง เช่น "อาคารประกันสังคม ชั้น 1"

9️⃣ instructions[]:
   คำแนะนำ bullet points
   เช่น "งดน้ำและอาหาร 8 ชม.", "นำผลเลือดมาด้วย"

═══════════════════════════════════════════════
✅ FINAL CHECKLIST (ก่อนตอบ):
═══════════════════════════════════════════════

ทำ self-audit:
[ ] doctor_name — มองหา label "ชื่อแพทย์/แพทย์" ทั้งซ้ายขวา?
[ ] patient_name — มองหา label "ชื่อผู้ป่วย"?
[ ] department — มองหา label "คลินิก/แผนก"?
[ ] hospital_name — อ่านตัวอักษรจริง ไม่ auto-correct?
[ ] hn — ตรวจสอบไม่ใช่ "เลขที่นัด"?
[ ] date_iso — แปลง พ.ศ. → ค.ศ. ถูก?
[ ] confidence — ให้ค่าตามจริง (0.6-0.95)

═══════════════════════════════════════════════
🎯 ตอบกลับเป็น JSON เท่านั้น ห้ามมี text นอก JSON:
═══════════════════════════════════════════════

{
  "doctor_name": "",
  "department": "",
  "hospital_name": "",
  "building": "",
  "date_str": "",
  "date_iso": "YYYY-MM-DD",
  "time_str": "",
  "hn": "",
  "patient_name": "",
  "instructions": [],
  "note": "",
  "confidence": 0.0
}`;

  try {
    const { parsed, usage } = await callClaudeVisionJSON({
      imageBase64: image_base64,
      mediaType,
      prompt,
      maxTokens: 800,
    });
    console.log('[scan-appointment] ok, tokens=', usage);
    res.json({ ok: true, data: parsed });
  } catch (e) {
    console.error('[scan-appointment] error:', e.message, e.status || '');
    if (e.message === 'ai_response_not_json') {
      return res.status(502).json({ error: 'ai_response_not_json', message: 'AI did not return valid JSON', raw: e.rawText });
    }
    res.status(e.status || 500).json({ error: 'ai_error', message: e.message });
  }
});

// ============================================================
//  ENDPOINT 2 — SCAN MEDICINE (v3 prompt)
// ============================================================
app.post('/api/scan-medicine', aiLimiter, async (req, res) => {
  const { image_base64, media_type } = req.body || {};
  if (!image_base64) return res.status(400).json({ error: 'missing_image', message: 'image_base64 is required' });

  const mediaType = media_type || 'image/jpeg';

  const prompt = SCAN_MEDICINE_PROMPT_V4;
  
  try {
    const { parsed, usage } = await callClaudeVisionJSON({
      imageBase64: image_base64,
      mediaType,
      prompt,
      maxTokens: 2000,
    });
    // Apply post-processor: half-tablet correction (safety net)
    const corrected = applyAllPostProcessors(parsed);
    console.log('[scan-medicine] ok, tokens=', usage);
    res.json({ ok: true, data: corrected });
  } catch (e) {
    console.error('[scan-medicine] error:', e.message, e.status || '');
    if (e.message === 'ai_response_not_json') {
      return res.status(502).json({ error: 'ai_response_not_json', message: 'AI did not return valid JSON', raw: e.rawText });
    }
    res.status(e.status || 500).json({ error: 'ai_error', message: e.message });
  }
});

// ============================================================
//  USER ENDPOINTS (MVP 1)
//  Rate limited: 20 req/min/IP
// ============================================================
const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit', message: 'Too many requests. Please wait a minute.' },
});

// readLimiter — สำหรับ GET ที่เบา (โหลดรูป/รายการ) ที่ frontend เรียกบ่อยมาก
// แยกจาก userLimiter เพราะ batch UI โหลด image/list ซ้ำ ๆ หลายสิบครั้ง/นาที
// ไม่กิน AI → ปล่อยให้สูงได้
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limit', message: 'Too many requests. Please wait a minute.' },
});

// Helper: generate a random link token (URL-safe base64)
function generateLinkToken() {
  return crypto.randomBytes(12).toString('base64url');  // 16 chars
}

// ─────────────────────────────────────────────────────────
// POST /api/users
// Create a new user (called from onboarding)
// ─────────────────────────────────────────────────────────
app.post('/api/users', userLimiter, async (req, res) => {
  const { 
    name, phone, age, gender,
    breakfast_time, lunch_time, dinner_time, bedtime,
    push_lead_minutes
  } = req.body || {};
  
  // Basic validation
  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    return res.status(400).json({ error: 'invalid_name', message: 'Name is required' });
  }
  if (age !== undefined && age !== null && (typeof age !== 'number' || age < 0 || age > 150)) {
    return res.status(400).json({ error: 'invalid_age' });
  }
  if (push_lead_minutes !== undefined && ![0, 5].includes(push_lead_minutes)) {
    return res.status(400).json({ error: 'invalid_push_lead_minutes', message: 'Must be 0 or 5' });
  }
  
  // Generate link token (expires in 24 hours)
  const linkToken = generateLinkToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  
  try {
    const result = await db.query(`
      INSERT INTO users (
        name, phone, age, gender,
        breakfast_time, lunch_time, dinner_time, bedtime,
        push_lead_minutes,
        link_token, link_expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id, name, link_token, created_at
    `, [
      name.trim(),
      phone || null,
      age || null,
      gender || null,
      breakfast_time || '07:00',
      lunch_time || '12:00',
      dinner_time || '18:00',
      bedtime || '21:00',
      push_lead_minutes ?? 0,
      linkToken,
      expiresAt
    ]);
    
    const user = result.rows[0];
    console.log(`[users] created id=${user.id} name="${user.name}"`);
    
    res.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        link_token: user.link_token,
        link_expires_at: expiresAt.toISOString(),
        created_at: user.created_at,
      }
    });
  } catch (e) {
    console.error('[users] create error:', e.message);
    res.status(500).json({ error: 'db_error', message: 'Failed to create user' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/users/:id
// Get user profile + LINE link status
// ─────────────────────────────────────────────────────────
app.get('/api/users/:id', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  
  try {
    const result = await db.query(`
      SELECT id, name, phone, age, gender,
             breakfast_time, lunch_time, dinner_time, bedtime,
             push_lead_minutes,
             line_user_id IS NOT NULL AS line_linked,
             link_token, link_expires_at,
             created_at
      FROM users
      WHERE id = $1 AND deleted_at IS NULL
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    
    const user = result.rows[0];
    res.json({ ok: true, user });
  } catch (e) {
    console.error('[users] get error:', e.message);
    res.status(500).json({ error: 'db_error' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/users/:id/refresh-token
// ─────────────────────────────────────────────────────────
app.post('/api/users/:id/refresh-token', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  
  const newToken = generateLinkToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  
  try {
    const result = await db.query(`
      UPDATE users
      SET link_token = $1, link_expires_at = $2
      WHERE id = $3 AND deleted_at IS NULL
      RETURNING id, link_token
    `, [newToken, expiresAt, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    
    res.json({
      ok: true,
      link_token: result.rows[0].link_token,
      link_expires_at: expiresAt.toISOString(),
    });
  } catch (e) {
    console.error('[users] refresh-token error:', e.message);
    res.status(500).json({ error: 'db_error' });
  }
});

// ============================================================
//  MEDICATIONS CRUD (NEW v1.4.0)
//  Rate limited: 20 req/min/IP
// ============================================================

// ── Helper: format TIME in HH:mm (strip seconds from '07:15:00' → '07:15') ──
function formatTimeHHmm(timeValue) {
  if (!timeValue) return null;
  const s = String(timeValue);
  return s.length >= 5 ? s.substring(0, 5) : s;
}

// ── Helper: parse 'HH:mm' to minutes since midnight ──
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return null;
  const parts = String(timeStr).split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

// ── Helper: format minutes since midnight → 'HH:mm' ──
function formatMinutesToHHmm(minutes) {
  // Handle negative or overflow by wrapping around 24h
  let m = ((minutes % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ── Helper: calculate reminder_time from user's meal times + schedule config ──
// Returns 'HH:mm' string, or null if invalid input
function calculateReminderTime(user, scheduleConfig) {
  const { meal_anchor, meal_relation, custom_time, time } = scheduleConfig;
  const leadMinutes = user.push_lead_minutes || 0;
  
  // 🕐 PATCH P7: Priority — custom_time overrides meal_anchor calculation
  // ถ้าฉลากระบุเวลาเฉพาะ (เช่น "เวลา 21.00") → ใช้ time ตรงๆ
  // ไม่คำนวณตาม meal_anchor → ไม่ apply meal_relation offset
  // Lead time ยังคง apply (เพื่อให้ผู้ป่วยได้รับเตือนล่วงหน้า)
  if (custom_time === true && time) {
    // Validate time format "HH:MM"
    const m = String(time).match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const h = parseInt(m[1]);
      const min = parseInt(m[2]);
      if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
        const totalMin = h * 60 + min - leadMinutes;
        return formatMinutesToHHmm(totalMin);
      }
    }
    // Invalid time format → fall through to meal_anchor logic
    console.warn(`[calculateReminderTime] Invalid custom time: "${time}", falling back to meal_anchor`);
  }
  
  // Determine base meal time
  let baseMealTime;
  switch (meal_anchor) {
    case 'breakfast': baseMealTime = formatTimeHHmm(user.breakfast_time); break;
    case 'lunch':     baseMealTime = formatTimeHHmm(user.lunch_time); break;
    case 'dinner':    baseMealTime = formatTimeHHmm(user.dinner_time); break;
    case 'bedtime':
      // 🌙 FIX: bedtime = "ก่อนนอน" → กินตรงเวลานอน ไม่ใช้ meal_relation offset
      // (ผู้ป่วยต้องการกินก่อนนอน ไม่ใช่ "หลังนอน 15 นาที")
      baseMealTime = formatTimeHHmm(user.bedtime);
      {
        const btMin = parseTimeToMinutes(baseMealTime);
        if (btMin === null) return null;
        return formatMinutesToHHmm(btMin - leadMinutes);
      }
    case 'all':
      // "หลังอาหาร" (ไม่ระบุมื้อ) — default to breakfast for now
      // Note: frontend should split "all" into 3 schedules (breakfast/lunch/dinner)
      baseMealTime = formatTimeHHmm(user.breakfast_time);
      break;
    default:
      return null;  // unknown anchor
  }
  
  const baseMinutes = parseTimeToMinutes(baseMealTime);
  if (baseMinutes === null) return null;
  
  // Apply meal_relation offset
  let offsetMinutes = 0;
  if (meal_relation === 'before') {
    offsetMinutes = -15;
  } else if (meal_relation === 'after') {
    offsetMinutes = 15;
  }
  // else: 'with' or '' (bedtime) → offset = 0
  
  // Apply lead time (push earlier)
  const finalMinutes = baseMinutes + offsetMinutes - leadMinutes;
  
  return formatMinutesToHHmm(finalMinutes);
}

// ── Helper: format number (ตัด .00 เก็บทศนิยมจำเป็น) ──
function fmtNum(n) {
  if (n === null || n === undefined || n === '') return '';
  const num = parseFloat(n);
  if (isNaN(num)) return String(n);
  return String(num);
}

// ── Helper: build LINE push message text for a batch of schedules ──
function buildReminderText(userName, schedules, leadMinutes) {
  const headerLine = leadMinutes > 0
    ? `🔔 อีก ${leadMinutes} นาที ถึงเวลากินยาแล้วครับ 💊`
    : `🔔 ถึงเวลากินยาแล้วครับ 💊`;
  
  const lines = [
    `🩺 หมอน้อยทักทายครับ คุณ${userName}!`,
    '',
    headerLine,
    ''
  ];
  
  // Build one line per medication
  for (const s of schedules) {
    const dose = s.dose_mg ? `${fmtNum(s.dose_mg)} ${s.dose_unit || 'mg'}` : '';
    // Multi-dose aware: show ml for liquids, tablets otherwise
    const qty = s.ml_per_dose
      ? `${fmtNum(s.ml_per_dose)} มล.`
      : (s.tablets_per_dose ? `${fmtNum(s.tablets_per_dose)} เม็ด` : '1 เม็ด');
    const timing = formatMealLabel(s.meal_anchor, s.meal_relation);
    const alert = s.is_high_alert ? '⚠️ ' : '';
    // ใช้ชื่อบนซอง (drug_name_raw) ก่อน — ให้คนไข้หาซองตรงกับที่เตือน
    const displayName = s.drug_name_raw || s.drug_name;
    
    const parts = [`💊 ${alert}${displayName}`];
    if (dose) parts.push(dose);
    parts.push(qty);
    if (timing) parts.push(timing);
    
    lines.push(parts.join(' · '));
  }
  
  lines.push('');
  lines.push('อย่าลืมนะครับ 😊');
  
  return lines.join('\n');
}

// ── Helper: convert meal_anchor + meal_relation to Thai label ──
function formatMealLabel(anchor, relation) {
  const relLabel = relation === 'before' ? 'ก่อนอาหาร' : relation === 'after' ? 'หลังอาหาร' : '';
  const anchorLabel = { breakfast: 'เช้า', lunch: 'เที่ยง', dinner: 'เย็น' }[anchor] || '';
  
  if (anchor === 'bedtime') return 'ก่อนนอน';
  if (anchor === 'all') return relLabel || 'พร้อมอาหาร';
  if (relLabel && anchorLabel) return relLabel + anchorLabel;
  return '';
}

// ─────────────────────────────────────────────────────────
// POST /api/medications
// Create new medication + auto-generate dose_schedules
// Body:
//   {
//     user_id, drug_name, drug_name_en?, dose_mg?, dose_unit?,
//     tablets_per_dose?, frequency_per_day?, timing_type?,
//     total_tablets?, total_days?, doctor_name?, hospital_name?,
//     dispense_date?,
//     schedules: [{ meal_anchor, meal_relation }, ...]
//   }
// Returns: { medication: {...}, schedules: [...] }
// ─────────────────────────────────────────────────────────
app.post('/api/medications', userLimiter, async (req, res) => {
  const {
    user_id, drug_name, drug_name_en, drug_name_raw, drug_brand,
    dose_mg, dose_unit,
    tablets_per_dose, frequency_per_day, timing_type,interval_hours,
    total_tablets, total_days, doctor_name, hospital_name,
    is_high_alert, drug_class,
    dispense_date, schedules
  } = req.body || {};
  
  // Validation
  if (!user_id || typeof user_id !== 'number') {
    return res.status(400).json({ error: 'invalid_user_id' });
  }
  if (!drug_name || typeof drug_name !== 'string' || drug_name.trim().length < 1) {
    return res.status(400).json({ error: 'invalid_drug_name' });
  }
  if (!Array.isArray(schedules) || schedules.length === 0) {
    return res.status(400).json({ error: 'missing_schedules', message: 'schedules array is required' });
  }
  if (schedules.length > 10) {
    return res.status(400).json({ error: 'too_many_schedules', message: 'Max 10 schedules per medication' });
  }
  
  // Fetch user (need meal times + push_lead_minutes)
  let user;
  try {
    const userResult = await db.query(`
      SELECT id, breakfast_time, lunch_time, dinner_time, bedtime, push_lead_minutes
      FROM users WHERE id = $1 AND deleted_at IS NULL
    `, [user_id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'user_not_found' });
    }
    user = userResult.rows[0];
  } catch (e) {
    console.error('[medications] user lookup error:', e.message);
    return res.status(500).json({ error: 'db_error' });
  }
  
  // Pre-calculate reminder times (validate before INSERT)
  const calculatedSchedules = [];
  for (const s of schedules) {
    if (!s.meal_anchor) {
      return res.status(400).json({ error: 'invalid_schedule', message: 'Each schedule needs meal_anchor' });
    }
    const reminderTime = calculateReminderTime(user, s);
    if (!reminderTime) {
      return res.status(400).json({ 
        error: 'invalid_schedule', 
        message: `Cannot calculate reminder_time for meal_anchor="${s.meal_anchor}"` 
      });
    }
    calculatedSchedules.push({
      meal_anchor: s.meal_anchor,
      meal_relation: s.meal_relation || '',
      reminder_time: reminderTime,
      tablets_per_dose: (s.tablets_per_dose !== undefined && s.tablets_per_dose !== null)
        ? parseFloat(s.tablets_per_dose) : 1,
      ml_per_dose: (s.ml_per_dose !== undefined && s.ml_per_dose !== null)
        ? parseFloat(s.ml_per_dose) : null,
      custom_time: s.custom_time === true,
      // PATCH P8: frequency pattern (daily / weekly / monthly / alternate / every_n_days)
      frequency_pattern: s.frequency_pattern || 'daily',
      frequency_interval: (s.frequency_interval !== undefined && s.frequency_interval !== null)
        ? parseInt(s.frequency_interval) : 1,
      day_of_week: (s.day_of_week !== undefined && s.day_of_week !== null && s.day_of_week !== '')
        ? parseInt(s.day_of_week) : null,
      day_of_month: (s.day_of_month !== undefined && s.day_of_month !== null && s.day_of_month !== '')
        ? parseInt(s.day_of_month) : null,
    });
  }
  
  // 🛡️ DEDUP CHECK: skip if same medication already active for this user
  // Strategy: Match by English name first (more reliable), Thai fallback
  // = AI สะกดไทยต่างกันได้ (ลอราซีแปม / ลอราเซแปม) แต่ English consistent
  console.log(`[medications] DEDUP CHECK: user=${user_id} drug_name="${drug_name}" drug_name_en="${drug_name_en}" dose_mg=${dose_mg}`);
  try {
    let existing = { rows: [] };
    
    // Priority 1: Match by drug_name_en (more reliable across AI inconsistency)
    if (drug_name_en && drug_name_en.trim()) {
      console.log(`[medications] DEDUP: trying English match "${drug_name_en}" with dose=${dose_mg}`);
      existing = await db.query(`
        SELECT id, drug_name, drug_name_en, dose_mg 
        FROM medications 
        WHERE user_id = $1 
          AND LOWER(TRIM(drug_name_en)) = LOWER(TRIM($2))
          AND COALESCE(dose_mg, 0) = COALESCE($3::numeric, 0)
          AND is_active = TRUE 
          AND deleted_at IS NULL
        LIMIT 1
      `, [user_id, drug_name_en, dose_mg || null]);
      
      console.log(`[medications] DEDUP: English query returned ${existing.rows.length} rows`);
      
      if (existing.rows.length > 0) {
        console.log(`[medications] DEDUP (en): "${drug_name_en}" matched id=${existing.rows[0].id} (Thai: "${existing.rows[0].drug_name}")`);
      }
    } else {
      console.log(`[medications] DEDUP: skipping English check (drug_name_en empty)`);
    }
    
    // Priority 2: Fallback to Thai name match (case-insensitive)
    if (existing.rows.length === 0) {
      console.log(`[medications] DEDUP: trying Thai match "${drug_name}" with dose=${dose_mg}`);
      existing = await db.query(`
        SELECT id, drug_name, drug_name_en, dose_mg 
        FROM medications 
        WHERE user_id = $1 
          AND LOWER(TRIM(drug_name)) = LOWER(TRIM($2))
          AND COALESCE(dose_mg, 0) = COALESCE($3::numeric, 0)
          AND is_active = TRUE 
          AND deleted_at IS NULL
        LIMIT 1
      `, [user_id, drug_name, dose_mg || null]);
      
      console.log(`[medications] DEDUP: Thai query returned ${existing.rows.length} rows`);
      
      if (existing.rows.length > 0) {
        console.log(`[medications] DEDUP (th): "${drug_name}" matched id=${existing.rows[0].id}`);
      }
    }
    
    if (existing.rows.length > 0) {
      const dup = existing.rows[0];
      console.log(`[medications] DEDUP: ✅ DEDUPLICATING — returning existing id=${dup.id}`);
      return res.status(200).json({ 
        ok: true, 
        deduplicated: true,
        message: 'Medication already exists',
        medication: { 
          id: dup.id, 
          drug_name: dup.drug_name, 
          drug_name_en: dup.drug_name_en,
          dose_mg: dup.dose_mg 
        },
        schedules: []
      });
    }
    
    console.log(`[medications] DEDUP: ❌ NO MATCH — proceeding to INSERT new`);
  } catch (e) {
    console.warn('[medications] dedup check failed (continuing):', e.message);
  }
  
  // Begin transaction: INSERT medication + schedules together
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    
    const medResult = await client.query(`
      INSERT INTO medications (
        user_id, drug_name, drug_name_en, drug_name_raw, drug_brand,
        dose_mg, dose_unit,
        timing_type, interval_hours,
        total_tablets, total_days, doctor_name, hospital_name,
        is_high_alert, drug_class,
        dispense_date
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *
    `, [
      user_id,
      drug_name.trim(),
      drug_name_en || null,
      drug_name_raw || null,
      drug_brand || null,
      dose_mg || null,
      dose_unit || 'mg',
      timing_type || 'meal',
      interval_hours || null,
      total_tablets || null,
      total_days || null,
      doctor_name || null,
      hospital_name || null,
      is_high_alert === true,
      drug_class || null,
      dispense_date || null
    ]);
    const medication = medResult.rows[0];
    
    // Insert schedules
    const insertedSchedules = [];
    for (const s of calculatedSchedules) {
      const schedResult = await client.query(`
        INSERT INTO dose_schedules (
          medication_id, user_id, reminder_time, meal_anchor, meal_relation,
          tablets_per_dose, ml_per_dose, custom_time,
          frequency_pattern, frequency_interval, day_of_week, day_of_month,
          start_date
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_DATE)
        RETURNING *
      `, [medication.id, user_id, s.reminder_time, s.meal_anchor, s.meal_relation,
          s.tablets_per_dose, s.ml_per_dose, s.custom_time === true,
          s.frequency_pattern || 'daily',
          s.frequency_interval || 1,
          s.day_of_week,
          s.day_of_month
      ]);
      insertedSchedules.push(schedResult.rows[0]);
    }
    
    await client.query('COMMIT');
    
    console.log(`[medications] created id=${medication.id} user=${user_id} drug="${medication.drug_name}" schedules=${insertedSchedules.length}`);
    
    res.json({
      ok: true,
      medication,
      schedules: insertedSchedules.map(s => ({
        ...s,
        reminder_time: formatTimeHHmm(s.reminder_time)
      }))
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[medications] create error:', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/medications?user_id=X
// List active medications with schedules
// ─────────────────────────────────────────────────────────
app.get('/api/medications', userLimiter, async (req, res) => {
  const user_id = parseInt(req.query.user_id);
  if (!user_id || isNaN(user_id)) {
    return res.status(400).json({ error: 'invalid_user_id', message: 'user_id query param required' });
  }
  
  try {
    const medResult = await db.query(`
      SELECT * FROM medications
      WHERE user_id = $1 AND is_active = TRUE AND deleted_at IS NULL
      ORDER BY created_at DESC
    `, [user_id]);
    
    if (medResult.rows.length === 0) {
      return res.json({ ok: true, medications: [] });
    }
    
    // Fetch schedules for all these medications in one query
    const medIds = medResult.rows.map(m => m.id);
    const schedResult = await db.query(`
      SELECT * FROM dose_schedules
      WHERE medication_id = ANY($1::int[]) AND is_active = TRUE
      ORDER BY medication_id, reminder_time
    `, [medIds]);
    
    // Group schedules by medication_id
    const schedulesByMed = {};
    for (const s of schedResult.rows) {
      if (!schedulesByMed[s.medication_id]) schedulesByMed[s.medication_id] = [];
      schedulesByMed[s.medication_id].push({
        ...s,
        reminder_time: formatTimeHHmm(s.reminder_time)
      });
    }
    
    const medications = medResult.rows.map(m => ({
      ...m,
      schedules: schedulesByMed[m.id] || []
    }));
    
    res.json({ ok: true, medications });
  } catch (e) {
    console.error('[medications] list error:', e.message);
    res.status(500).json({ error: 'db_error' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/medications/:id
// Get single medication with schedules
// ─────────────────────────────────────────────────────────
app.get('/api/medications/:id', userLimiter, async (req, res, next) => {
  // Skip if :id is not numeric (let other routes like /refill-status handle it)
  if (!/^\d+$/.test(req.params.id)) return next();
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  
  try {
    const medResult = await db.query(`
      SELECT * FROM medications
      WHERE id = $1 AND deleted_at IS NULL
    `, [id]);
    
    if (medResult.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    
    const schedResult = await db.query(`
      SELECT * FROM dose_schedules
      WHERE medication_id = $1 AND is_active = TRUE
      ORDER BY reminder_time
    `, [id]);
    
    const medication = medResult.rows[0];
    const schedules = schedResult.rows.map(s => ({
      ...s,
      reminder_time: formatTimeHHmm(s.reminder_time)
    }));
    
    res.json({ ok: true, medication, schedules });
  } catch (e) {
    console.error('[medications] get error:', e.message);
    res.status(500).json({ error: 'db_error' });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/medications/:id
// Update medication fields (simple update — does NOT recalculate schedules)
// To change schedules, delete + create new medication
// ─────────────────────────────────────────────────────────
app.patch('/api/medications/:id', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  
  const allowedFields = [
    'drug_name', 'drug_name_en', 'dose_mg', 'dose_unit',
    'tablets_per_dose', 'frequency_per_day', 'timing_type','interval_hours',
    'total_tablets', 'total_days', 'doctor_name', 'hospital_name',
    'dispense_date', 'is_active', 'paused_until'
  ];
  
  const updates = [];
  const values = [];
  let i = 1;
  for (const field of allowedFields) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, field)) {
      updates.push(`${field} = $${i}`);
      values.push(req.body[field]);
      i++;
    }
  }
  
  if (updates.length === 0) {
    return res.status(400).json({ error: 'no_fields_to_update' });
  }
  
  values.push(id);
  
  try {
    const result = await db.query(`
      UPDATE medications
      SET ${updates.join(', ')}
      WHERE id = $${i} AND deleted_at IS NULL
      RETURNING *
    `, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    
    console.log(`[medications] updated id=${id} fields=${updates.length}`);
    res.json({ ok: true, medication: result.rows[0] });
  } catch (e) {
    console.error('[medications] update error:', e.message);
    res.status(500).json({ error: 'db_error' });
  }
});

// ─────────────────────────────────────────────────────────
// DELETE /api/medications/:id
// Soft delete + deactivate schedules
// ─────────────────────────────────────────────────────────
app.delete('/api/medications/:id', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    
    const medResult = await client.query(`
      UPDATE medications
      SET is_active = FALSE, deleted_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id
    `, [id]);
    
    if (medResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }
    
    // Deactivate schedules (but keep rows for audit)
    await client.query(`
      UPDATE dose_schedules
      SET is_active = FALSE
      WHERE medication_id = $1
    `, [id]);
    
    await client.query('COMMIT');
    
    console.log(`[medications] soft-deleted id=${id}`);
    res.json({ ok: true, id });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[medications] delete error:', e.message);
    res.status(500).json({ error: 'db_error' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/users/:id
// Update user settings (meal times, push_lead_minutes, etc.)
// ⚠️ Known limitation: does NOT recalculate existing dose_schedules
//    (will be added in Session 4)
// ─────────────────────────────────────────────────────────
app.patch('/api/users/:id', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'invalid_id' });
  
  const allowedFields = [
    'name', 'phone', 'age', 'gender',
    'breakfast_time', 'lunch_time', 'dinner_time', 'bedtime',
    'push_lead_minutes'
  ];
  
  const updates = [];
  const values = [];
  let i = 1;
  for (const field of allowedFields) {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, field)) {
      // Validate push_lead_minutes
      if (field === 'push_lead_minutes' && ![0, 5].includes(req.body[field])) {
        return res.status(400).json({ error: 'invalid_push_lead_minutes', message: 'Must be 0 or 5' });
      }
      updates.push(`${field} = $${i}`);
      values.push(req.body[field]);
      i++;
    }
  }
  
  if (updates.length === 0) {
    return res.status(400).json({ error: 'no_fields_to_update' });
  }
  
  values.push(id);
  
  try {
    const result = await db.query(`
      UPDATE users
      SET ${updates.join(', ')}
      WHERE id = $${i} AND deleted_at IS NULL
      RETURNING id, name, breakfast_time, lunch_time, dinner_time, bedtime, push_lead_minutes
    `, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    
    // Check if user has active medications → warn about stale schedules
    const medCheck = await db.query(`
      SELECT COUNT(*)::int AS cnt FROM medications 
      WHERE user_id = $1 AND is_active = TRUE AND deleted_at IS NULL
    `, [id]);
    const activeMedsCount = medCheck.rows[0].cnt;
    
    console.log(`[users] updated id=${id} fields=${updates.length} active_meds=${activeMedsCount}`);
    
    const response = {
      ok: true,
      user: {
        ...result.rows[0],
        breakfast_time: formatTimeHHmm(result.rows[0].breakfast_time),
        lunch_time: formatTimeHHmm(result.rows[0].lunch_time),
        dinner_time: formatTimeHHmm(result.rows[0].dinner_time),
        bedtime: formatTimeHHmm(result.rows[0].bedtime),
      }
    };
    
    if (activeMedsCount > 0 && updates.some(u => /_time|push_lead/.test(u))) {
      response.warning = `User has ${activeMedsCount} active medications. Their reminder_time values are NOT recalculated — recreate them to apply new settings.`;
    }
    
    res.json(response);
  } catch (e) {
    console.error('[users] update error:', e.message);
    res.status(500).json({ error: 'db_error' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/push-logs?user_id=X&limit=N
// Get push history for a user (most recent first)
// ─────────────────────────────────────────────────────────
app.get('/api/push-logs', userLimiter, async (req, res) => {
  const user_id = parseInt(req.query.user_id);
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  
  if (!user_id || isNaN(user_id)) {
    return res.status(400).json({ error: 'invalid_user_id', message: 'user_id query param required' });
  }
  
  try {
    const result = await db.query(`
      SELECT 
        id, user_id, schedule_ids, scheduled_for, sent_at, status, error_message, created_at
      FROM push_logs
      WHERE user_id = $1
      ORDER BY id DESC
      LIMIT $2
    `, [user_id, limit]);
    
    // Also return monthly count (for quota display)
    const countResult = await db.query(`
      SELECT COUNT(*)::int AS monthly_count
      FROM push_logs
      WHERE status = 'sent' AND sent_at > NOW() - INTERVAL '30 days'
    `);
    
    res.json({
      ok: true,
      logs: result.rows,
      monthly_push_count: countResult.rows[0].monthly_count,
      quota_limit: PUSH_QUOTA_MONTHLY,
    });
  } catch (e) {
    console.error('[push-logs] list error:', e.message);
    res.status(500).json({ error: 'db_error' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/debug/schedule-check
// Debug endpoint: ดูข้อมูลที่ scheduler จะ query เจอ ณ เวลาปัจจุบัน
// (ไม่ push จริง — แค่ inspect)
// Query params:
//   user_id (optional) — filter by user
//   time (optional)    — override HH:mm for testing (default: now Bangkok)
// ─────────────────────────────────────────────────────────
app.get('/api/debug/schedule-check', userLimiter, async (req, res) => {
  const user_id = req.query.user_id ? parseInt(req.query.user_id) : null;
  const timeOverride = req.query.time;  // e.g. "14:35"
  
  // Get current Bangkok HH:mm
  const nowBangkok = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  
  const checkTime = timeOverride || nowBangkok;
  
  try {
    // 1. What scheduler query would find right now
    const schedulerQuery = await db.query(`
      SELECT 
        ds.id AS schedule_id, ds.medication_id, ds.user_id,
        ds.meal_anchor, ds.meal_relation,
        TO_CHAR(ds.reminder_time, 'HH24:MI') AS reminder_time,
        ds.is_active AS sched_active, ds.end_date,
        m.drug_name, m.is_active AS med_active, m.deleted_at AS med_deleted_at, m.paused_until,
        u.name AS user_name, u.line_user_id, u.deleted_at AS user_deleted_at
      FROM dose_schedules ds
      JOIN medications m ON m.id = ds.medication_id
      JOIN users u ON u.id = ds.user_id
      WHERE TO_CHAR(ds.reminder_time, 'HH24:MI') = $1
      ${user_id ? 'AND ds.user_id = $2' : ''}
      ORDER BY ds.user_id, ds.reminder_time
    `, user_id ? [checkTime, user_id] : [checkTime]);
    
    // 2. All active schedules for user (no time filter) — to see what reminder_times exist
    let allSchedules = { rows: [] };
    if (user_id) {
      allSchedules = await db.query(`
        SELECT 
          ds.id, ds.medication_id,
          TO_CHAR(ds.reminder_time, 'HH24:MI') AS reminder_time,
          ds.meal_anchor, ds.meal_relation, ds.is_active,
          m.drug_name, m.is_active AS med_active, m.deleted_at AS med_deleted_at
        FROM dose_schedules ds
        JOIN medications m ON m.id = ds.medication_id
        WHERE ds.user_id = $1
        ORDER BY ds.reminder_time
      `, [user_id]);
    }
    
    // 3. User info
    let userInfo = null;
    if (user_id) {
      const u = await db.query(`
        SELECT id, name, line_user_id, breakfast_time, lunch_time, dinner_time, bedtime,
               push_lead_minutes, deleted_at
        FROM users WHERE id = $1
      `, [user_id]);
      userInfo = u.rows[0] ? {
        ...u.rows[0],
        breakfast_time: formatTimeHHmm(u.rows[0].breakfast_time),
        lunch_time: formatTimeHHmm(u.rows[0].lunch_time),
        dinner_time: formatTimeHHmm(u.rows[0].dinner_time),
        bedtime: formatTimeHHmm(u.rows[0].bedtime),
      } : null;
    }
    
    // 4. Step-by-step filter analysis — why each schedule would/wouldn't trigger
    const analysis = schedulerQuery.rows.map(r => {
      const checks = {
        time_matches:       true,  // always true since we filtered by time
        schedule_active:    r.sched_active === true,
        medication_active:  r.med_active === true,
        medication_alive:   r.med_deleted_at === null,
        medication_not_paused: r.paused_until === null || new Date(r.paused_until) < new Date(),
        schedule_not_ended: r.end_date === null || new Date(r.end_date) >= new Date(Date.now() - 86400000),
        user_has_line:      r.line_user_id !== null && r.line_user_id !== '',
        user_alive:         r.user_deleted_at === null,
      };
      const wouldTrigger = Object.values(checks).every(v => v === true);
      return { ...r, checks, wouldTrigger };
    });
    
    res.json({
      ok: true,
      debug: {
        server_time_utc: new Date().toISOString(),
        bangkok_time: nowBangkok,
        check_time_used: checkTime,
        overridden: !!timeOverride,
      },
      user_info: userInfo,
      schedules_matching_time: schedulerQuery.rows.length,
      schedules_would_trigger: analysis.filter(a => a.wouldTrigger).length,
      analysis: analysis,
      all_user_schedules: allSchedules.rows,
    });
  } catch (e) {
    console.error('[debug/schedule-check] error:', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// ============================================================
//  LINE WEBHOOK
// ============================================================

// Helper: send reply to LINE (uses reply API — FREE, doesn't count against push quota)
async function lineReply(replyToken, messages) {
  if (!lineClient) {
    console.warn('[line] lineClient not initialized — skipping reply');
    return;
  }
  const msgs = Array.isArray(messages) ? messages : [{ type: 'text', text: messages }];
  try {
    await lineClient.replyMessage(replyToken, msgs);
  } catch (e) {
    console.error('[line] reply error:', e.message);
  }
}

// Handle follow event (user added friend)
async function handleFollowEvent(event) {
  const lineUserId = event.source.userId;
  console.log('[line] follow event from userId:', lineUserId);
  
  // Path B: Check if user already exists
  let existingUser = null;
  try {
    const result = await db.query(
      `SELECT id, name FROM users WHERE line_user_id = $1 AND deleted_at IS NULL`,
      [lineUserId]
    );
    if (result.rows.length > 0) existingUser = result.rows[0];
  } catch (e) {
    console.error('[line] follow event db error:', e.message);
  }
  
  let welcomeText;
  
  if (existingUser) {
    // Returning user — they re-added the OA
    welcomeText = [
      `🩺 ยินดีต้อนรับกลับครับ คุณ${existingUser.name.split(' ')[0]}!`,
      '',
      'หมอน้อยพร้อมช่วยดูแลการกินยาของคุณต่อแล้วครับ 💊',
      '',
      '📱 เปิดแอพ MedTrack:',
      'https://app.medtrackq.com/medtrack-app/medtrack-home.html?lineUserId=' + lineUserId,
    ].join('\n');
  } else {
    // New user — invite to onboarding
    welcomeText = [
      '🩺 สวัสดีครับ! ยินดีต้อนรับสู่ MedTrack',
      '',
      'ผมคือ "หมอน้อย" ผู้ช่วย AI ดูแลการกินยาของคุณ',
      '',
      '✨ เริ่มต้นใช้งานง่ายๆ:',
      'https://app.medtrackq.com/medtrack-app/medtrack-onboard.html?lineUserId=' + lineUserId,
      '',
      '📋 หรือเชื่อมต่อกับบัญชีที่มีอยู่:',
      'พิมพ์: /link {รหัสเชื่อมต่อ}',
      '(รหัสอยู่ในแอพ MedTrack)',
    ].join('\n');
  }
  
  await lineReply(event.replyToken, welcomeText);
}

// Handle unfollow event (user removed friend) — soft delete link
async function handleUnfollowEvent(event) {
  const lineUserId = event.source.userId;
  console.log('[line] unfollow event from userId:', lineUserId);
  
  try {
    await db.query(
      `UPDATE users SET line_user_id = NULL WHERE line_user_id = $1`,
      [lineUserId]
    );
    console.log('[line] unlinked user from line_user_id:', lineUserId);
  } catch (e) {
    console.error('[line] unfollow db error:', e.message);
  }
}

// Handle message event (parse /link command)
async function handleMessageEvent(event) {
  if (event.message.type !== 'text') return;
  
  const lineUserId = event.source.userId;
  const text = (event.message.text || '').trim();
  
  console.log('[line] message from', lineUserId, ':', text.substring(0, 50));
  
  const linkMatch = text.match(/^\/link\s+([a-zA-Z0-9_\-]+)$/i);
  if (linkMatch) {
    return handleLinkCommand(event, linkMatch[1]);
  }
  
  // Phase 2: caregiver linking
  const careMatch = text.match(/^\/care\s+([a-zA-Z0-9]+)$/i);
  if (careMatch) {
    return caregiverModule.handleCareCommand(db, event, careMatch[1], lineReply);
  }
  
  const userResult = await db.query(
    `SELECT id, name FROM users WHERE line_user_id = $1 AND deleted_at IS NULL`,
    [lineUserId]
  );
  
  if (text.match(/^\/(help|status|info)/i)) {
    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      await lineReply(event.replyToken, [
        { type: 'text', text: `สวัสดีครับ คุณ ${user.name} 👋\n\nบัญชีของคุณเชื่อมกับ LINE แล้ว\n\nคำสั่งที่ใช้ได้:\n/status — ดูสถานะ\n/help — วิธีใช้งาน` }
      ]);
    } else {
      await lineReply(event.replyToken, [
        { type: 'text', text: '❗ คุณยังไม่ได้เชื่อมบัญชี\n\nกรุณาพิมพ์: /link {รหัสเชื่อมต่อ}\n(หารหัสได้จากหน้า "เชื่อม LINE" ในแอพ)' }
      ]);
    }
    return;
  }
  
  if (userResult.rows.length === 0) {
    await lineReply(event.replyToken, [
      { type: 'text', text: '🔗 กรุณาเชื่อมบัญชี MedTrack ของคุณก่อน\n\nพิมพ์: /link {รหัส}\n(ดูรหัสในแอพ MedTrack)' }
    ]);
  }
}

// Handle /link command — verify token and link account
async function handleLinkCommand(event, token) {
  const lineUserId = event.source.userId;
  console.log('[line] /link attempt from', lineUserId, 'token:', token.substring(0, 4) + '...');
  
  try {
    const result = await db.query(`
      SELECT id, name, line_user_id, link_expires_at
      FROM users
      WHERE link_token = $1 
        AND deleted_at IS NULL
        AND (link_expires_at IS NULL OR link_expires_at > NOW())
      LIMIT 1
    `, [token]);
    
    if (result.rows.length === 0) {
      await lineReply(event.replyToken, [
        { type: 'text', text: '❌ รหัสเชื่อมต่อไม่ถูกต้องหรือหมดอายุแล้ว\n\nกรุณากลับไปที่แอพ MedTrack เพื่อขอรหัสใหม่' }
      ]);
      return;
    }
    
    const user = result.rows[0];
    
    if (user.line_user_id && user.line_user_id !== lineUserId) {
      await lineReply(event.replyToken, [
        { type: 'text', text: '⚠️ บัญชีนี้เชื่อมกับ LINE อื่นอยู่แล้ว\n\nกรุณาติดต่อทีมงาน MedTrack หากต้องการเปลี่ยน LINE' }
      ]);
      return;
    }
    
    const existingLink = await db.query(
      `SELECT id, name FROM users WHERE line_user_id = $1 AND id != $2 AND deleted_at IS NULL`,
      [lineUserId, user.id]
    );
    if (existingLink.rows.length > 0) {
      await lineReply(event.replyToken, [
        { type: 'text', text: `⚠️ LINE ของคุณเชื่อมกับบัญชี "${existingLink.rows[0].name}" อยู่แล้ว\n\nกรุณาเลิกเชื่อมก่อนจึงจะผูกบัญชีใหม่ได้` }
      ]);
      return;
    }
    
    await db.query(`
      UPDATE users 
      SET line_user_id = $1, 
          link_token = NULL, 
          link_expires_at = NULL
      WHERE id = $2
    `, [lineUserId, user.id]);
    
    console.log('[line] linked userId', user.id, '→ lineUserId', lineUserId);
    
    await lineReply(event.replyToken, [
      { type: 'text', text: `✅ เชื่อมบัญชีสำเร็จ!\n\nสวัสดีครับ คุณ ${user.name} 👋\n\nจากนี้ไปหมอน้อยจะคอยเตือนคุณกินยาตรงเวลาผ่าน LINE นี้ครับ 💊` }
    ]);
  } catch (e) {
    console.error('[line] /link error:', e.message);
    await lineReply(event.replyToken, [
      { type: 'text', text: '❗ เกิดข้อผิดพลาด กรุณาลองใหม่ในภายหลัง' }
    ]);
  }
}

// Route incoming webhook event to appropriate handler
async function handleLineEvent(event) {
  try {
    switch (event.type) {
      case 'follow':
        return handleFollowEvent(event);
      case 'unfollow':
        return handleUnfollowEvent(event);
      case 'message':
        return handleMessageEvent(event);
      case 'postback':
        return handlePostbackEvent(event);
      default:
        console.log('[line] ignored event type:', event.type);
    }
  } catch (e) {
    console.error('[line] event handler error:', e.message);
  }
}

// POST /webhook/line
app.post('/webhook/line', async (req, res) => {
  if (!lineClient) {
    console.error('[line] webhook called but LINE not configured');
    return res.status(500).json({ error: 'line_not_configured' });
  }
  
  const signature = req.headers['x-line-signature'];
  const rawBody = req.rawBody;
  
  if (!signature || !rawBody) {
    console.warn('[line] missing signature or raw body');
    return res.status(401).json({ error: 'invalid_signature' });
  }
  
  const expectedSignature = crypto
    .createHmac('sha256', LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest('base64');
  
  if (signature !== expectedSignature) {
    console.warn('[line] signature mismatch — request rejected');
    return res.status(401).json({ error: 'invalid_signature' });
  }
  
  const events = req.body.events || [];
  res.json({ ok: true });
  
  for (const event of events) {
    handleLineEvent(event).catch(e => {
      console.error('[line] unhandled event error:', e);
    });
  }
});

// ════════════════════════════════════════════════════════
//  PHASE 1: CONFIRMATION SYSTEM (Session 6)
//  - Flex Message templates for reminders
//  - Postback event handler (✅ กินแล้ว / ⏭️ ข้าม buttons)
//  - Manual confirm + today's doses endpoints
//  - Missed dose marker cron
// ════════════════════════════════════════════════════════

// Build Flex Message with confirm/skip buttons
function buildReminderFlexMessage(userName, schedules, doseLogIds) {
  // Use first word as first name (Thai convention) — fixes "คุณTest" bug
  const firstName = (userName && userName.trim().split(/\s+/)[0]) || userName || '';
  
  const medContents = schedules.map((s, i) => {
    const mealText = formatMealRelationFlex(s.meal_relation, s.meal_anchor);
    // ใช้ชื่อบนซอง (drug_name_raw) ก่อน — ตรงกับซองที่คนไข้ถือ
    const displayName = s.drug_name_raw || s.drug_name;
    const doseText = s.dose_mg ? ` ${fmtNum(s.dose_mg)} ${s.dose_unit || 'mg'}` : '';
    return {
      type: 'box',
      layout: 'vertical',
      margin: i > 0 ? 'md' : 'none',
      contents: [
        {
          type: 'text',
          text: `💊 ${displayName}${doseText}`,
          weight: 'bold',
          size: 'md',
          wrap: true
        },
        {
          type: 'text',
          text: `${s.tablets_per_dose || 1} เม็ด · ${mealText}`,
          size: 'sm',
          color: '#666666',
          wrap: true
        }
      ]
    };
  });
  
  // Use first dose ID for the button (confirm-all=1 confirms all at same time)
  const primaryDoseId = doseLogIds[0] || 0;
  
  return {
    type: 'flex',
    altText: `🔔 ถึงเวลากินยา ${schedules.map(s => s.drug_name).join(', ')}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0A9C7A',
        paddingAll: '12px',
        contents: [
          { type: 'text', text: '🩺 หมอน้อย', color: '#FFFFFF', size: 'sm', weight: 'bold' },
          { type: 'text', text: '🔔 ถึงเวลากินยาแล้วครับ', color: '#FFFFFF', size: 'lg', weight: 'bold', margin: 'sm' },
          { type: 'text', text: `คุณ${firstName}`, color: '#FFFFFF', size: 'xs', margin: 'xs' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '12px',
        contents: medContents
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        paddingAll: '12px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: '#0A9C7A',
            height: 'sm',
            action: {
              type: 'postback',
              label: '✅ กินแล้ว',
              data: `action=confirm&dose_id=${primaryDoseId}&all=1`,
              displayText: '✅ กินยาเรียบร้อยแล้วครับ'
            }
          },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: '⏭️ ข้าม',
              data: `action=skip&dose_id=${primaryDoseId}&all=1`,
              displayText: 'ขอข้ามมื้อนี้'
            }
          }
        ]
      }
    }
  };
}

function formatMealRelationFlex(relation, anchor) {
  const anchorMap = {
    breakfast: 'อาหารเช้า', lunch: 'อาหารกลางวัน',
    dinner: 'อาหารเย็น', bedtime: 'ก่อนนอน', all: 'อาหาร'
  };
  const relMap = { before: 'ก่อน', after: 'หลัง', with: 'พร้อม', '': '' };
  if (anchor === 'bedtime') return 'ก่อนนอน';
  return `${relMap[relation] || 'หลัง'}${anchorMap[anchor] || 'อาหาร'}`;
}

function parseQueryString(qs) {
  const params = {};
  (qs || '').split('&').forEach(pair => {
    const [k, v] = pair.split('=');
    params[k] = decodeURIComponent(v || '');
  });
  return params;
}

// Postback handler — entry point from webhook event router
async function handlePostbackEvent(event) {
  const data = parseQueryString(event.postback?.data);
  const action = data.action;
  const doseId = parseInt(data.dose_id);
  const all = data.all === '1';
  
  console.log('[postback]', action, 'dose_id=' + doseId, 'all=' + all);
  
  if (!doseId) {
    return lineReply(event.replyToken, [{ type: 'text', text: '⚠️ ข้อมูลไม่ครบ' }]);
  }
  
  if (action === 'confirm') {
    return handleConfirmDose(event, doseId, all);
  } else if (action === 'skip') {
    return handleSkipDose(event, doseId, all);
  } else if (action === 'cg_confirm' || action === 'cg_snooze') {
    // Phase 2: caregiver actions
    return caregiverModule.handleCaregiverPostback(db, event, action, doseId, lineClient, lineReply);
  }
}

async function handleConfirmDose(event, doseId, confirmAll) {
  const doseResult = await db.query(`
    SELECT dl.*, m.drug_name, u.name as user_name
    FROM dose_logs dl
    JOIN medications m ON m.id = dl.medication_id
    JOIN users u ON u.id = dl.user_id
    WHERE dl.id = $1
  `, [doseId]);
  
  if (!doseResult.rows.length) {
    return lineReply(event.replyToken, [{ type: 'text', text: '⚠️ ไม่พบข้อมูลยา' }]);
  }
  
  const dose = doseResult.rows[0];
  
  if (dose.status !== 'pending') {
    return lineReply(event.replyToken, [{ 
      type: 'text', 
      text: `✅ ยา ${dose.drug_name} ได้ยืนยันไปแล้วครับ`
    }]);
  }
  
  // Calculate timing
  const now = new Date();
  const scheduled = new Date(dose.scheduled_at);
  const minLate = (now - scheduled) / 60000;
  
  let newStatus, points;
  if (minLate <= 15) { newStatus = 'taken'; points = 10; }
  else if (minLate <= 120) { newStatus = 'late'; points = 3; }
  else { newStatus = 'late'; points = 1; }
  
  let allDrugs = [dose.drug_name];
  let totalConfirmed = 1;
  
  if (confirmAll) {
    const others = await db.query(`
      SELECT dl.id, m.drug_name 
      FROM dose_logs dl
      JOIN medications m ON m.id = dl.medication_id
      WHERE dl.user_id = $1 AND dl.scheduled_at = $2 
        AND dl.status = 'pending' AND dl.id != $3
    `, [dose.user_id, dose.scheduled_at, doseId]);
    
    for (const other of others.rows) {
      await db.query(`
        UPDATE dose_logs 
        SET status = $1, confirmed_at = NOW(), confirmed_by = 'user', reward_points = $2
        WHERE id = $3
      `, [newStatus, points, other.id]);
      
      // Increment medication actual_doses_taken
      await db.query(`
        UPDATE medications 
        SET actual_doses_taken = COALESCE(actual_doses_taken, 0) + 1,
            last_confirmed_at = NOW()
        WHERE id = (SELECT medication_id FROM dose_logs WHERE id = $1)
      `, [other.id]);
      
      allDrugs.push(other.drug_name);
      totalConfirmed++;
    }
  }
  
  // Update primary dose
  await db.query(`
    UPDATE dose_logs 
    SET status = $1, confirmed_at = NOW(), confirmed_by = 'user', reward_points = $2
    WHERE id = $3
  `, [newStatus, points, doseId]);
  
  await db.query(`
    UPDATE medications 
    SET actual_doses_taken = COALESCE(actual_doses_taken, 0) + 1,
        last_confirmed_at = NOW()
    WHERE id = $1
  `, [dose.medication_id]);
  
  // Phase 2: Notify caregiver if they were alerted for this dose
  try {
    await caregiverModule.notifyCaregiverOfLateConfirm(
      db, lineClient, doseId, dose.drug_name, dose.user_name || 'ผู้ป่วย'
    );
  } catch (e) {
    console.error('[caregiver-notify] Failed:', e.message);
  }
  
  const totalPoints = points * totalConfirmed;
  let msg;
  if (newStatus === 'taken') {
    msg = `✅ ดีมากครับ!\n\n💊 ${allDrugs.join(', ')}\n🏆 +${totalPoints} แต้ม`;
  } else {
    msg = `✅ บันทึกแล้ว (ช้าไป ${Math.round(minLate)} นาที)\n\n💊 ${allDrugs.join(', ')}\n🏆 +${totalPoints} แต้ม`;
  }
  
  return lineReply(event.replyToken, [{ type: 'text', text: msg }]);
}

async function handleSkipDose(event, doseId, skipAll) {
  const doseResult = await db.query(
    'SELECT dl.*, m.drug_name FROM dose_logs dl JOIN medications m ON m.id = dl.medication_id WHERE dl.id = $1',
    [doseId]
  );
  
  if (!doseResult.rows.length) {
    return lineReply(event.replyToken, [{ type: 'text', text: '⚠️ ไม่พบข้อมูลยา' }]);
  }
  
  const dose = doseResult.rows[0];
  
  if (dose.status !== 'pending') {
    return lineReply(event.replyToken, [{ 
      type: 'text', 
      text: `ยา ${dose.drug_name} ได้บันทึกไปแล้วครับ`
    }]);
  }
  
  await db.query(
    `UPDATE dose_logs SET status = 'skipped', confirmed_at = NOW(), confirmed_by = 'user' WHERE id = $1`,
    [doseId]
  );
  
  if (skipAll) {
    await db.query(`
      UPDATE dose_logs 
      SET status = 'skipped', confirmed_at = NOW(), confirmed_by = 'user'
      WHERE user_id = $1 AND scheduled_at = $2 AND status = 'pending'
    `, [dose.user_id, dose.scheduled_at]);
  }
  
  return lineReply(event.replyToken, [{ 
    type: 'text', 
    text: `📝 บันทึกการข้ามมื้อนี้แล้ว\nยาจะไม่ลด — ขอให้มื้อหน้าครบนะครับ 💪`
  }]);
}

// ─── Manual confirm endpoint (from home.html button) ───
app.post('/api/dose-logs/:id/confirm', userLimiter, async (req, res) => {
  const doseId = parseInt(req.params.id);
  if (!doseId) return res.status(400).json({ error: 'invalid_dose_id' });
  
  try {
    const result = await db.query(`
      UPDATE dose_logs 
      SET status = 'taken', confirmed_at = NOW(), confirmed_by = 'user', reward_points = 10
      WHERE id = $1 AND status = 'pending'
      RETURNING *
    `, [doseId]);
    
    if (!result.rows.length) {
      return res.status(404).json({ error: 'not_found_or_already_confirmed' });
    }
    
    await db.query(`
      UPDATE medications 
      SET actual_doses_taken = COALESCE(actual_doses_taken, 0) + 1,
          last_confirmed_at = NOW()
      WHERE id = $1
    `, [result.rows[0].medication_id]);
    
    res.json({ ok: true, dose_log: result.rows[0] });
  } catch (e) {
    console.error('[POST /api/dose-logs/:id/confirm]', e);
    res.status(500).json({ error: 'server_error', message: e.message });
  }
});

// ─── Get today's doses for user (for home.html) ───
app.get('/api/dose-logs/today', userLimiter, async (req, res) => {
  const userId = parseInt(req.query.user_id);
  if (!userId) return res.status(400).json({ error: 'user_id_required' });
  
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    
    // Strategy: dose_schedules (real schedule) + LEFT JOIN dose_logs (today's status)
    // This shows ALL meds for today even if cron hasn't created dose_logs yet
    const result = await db.query(`
      SELECT 
        ds.id AS schedule_id,
        ds.reminder_time AS scheduled_time,
        ds.meal_anchor,
        ds.meal_relation,
        m.id AS medication_id,
        m.drug_name, m.drug_name_raw, m.dose_mg, m.dose_unit,
        ds.tablets_per_dose, ds.ml_per_dose,
        dl.id, dl.status, dl.confirmed_at, dl.reward_points
      FROM dose_schedules ds
      JOIN medications m ON m.id = ds.medication_id
      LEFT JOIN dose_logs dl ON 
        dl.schedule_id = ds.id 
        AND dl.scheduled_date = $2
        AND dl.user_id = $1
      WHERE m.user_id = $1 
        AND m.deleted_at IS NULL 
        AND m.is_active = TRUE
        AND ds.is_active = TRUE
      ORDER BY ds.reminder_time
    `, [userId, today]);
    
    res.json({ ok: true, doses: result.rows, date: today });
  } catch (e) {
    console.error('[GET /api/dose-logs/today]', e);
    res.status(500).json({ error: 'server_error', message: e.message });
  }
});

// ─── Missed dose marker cron (every 5 minutes) ───
let missedDoseTask = null;
function startMissedDoseCron() {
  if (missedDoseTask) return;
  missedDoseTask = cron.schedule('*/5 * * * *', async () => {
    try {
      const result = await db.query(`
        UPDATE dose_logs 
        SET status = 'missed' 
        WHERE status = 'pending' 
          AND scheduled_at < NOW() - INTERVAL '120 minutes'
        RETURNING id
      `);
      if (result.rows.length > 0) {
        console.log(`[missed-cron] Marked ${result.rows.length} doses as missed`);
      }
    } catch (e) {
      console.error('[missed-cron] Error:', e.message);
    }
  }, { scheduled: true, timezone: 'Asia/Bangkok' });
  console.log('✅ Missed dose cron started (every 5 minutes, Asia/Bangkok)');
}

// ════════════════════════════════════════════════════════
//  END PHASE 1
// ════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════
//  PHASE 2: CAREGIVER ENDPOINTS (Session 7)
// ════════════════════════════════════════════════════════

// POST /api/caregivers — Create caregiver invite
app.post('/api/caregivers', userLimiter, async (req, res) => {
  const { user_id, name, relationship, phone, alert_threshold_minutes } = req.body || {};
  
  if (!user_id || !name) {
    return res.status(400).json({ error: 'missing_fields', message: 'user_id and name required' });
  }
  
  try {
    // Note: Multi-caregiver supported (no limit)
    // Each caregiver receives alert when patient misses dose
    
    // Optional: Soft limit at 5 caregivers (prevent abuse)
    const existingCount = await db.query(
      `SELECT COUNT(*) as cnt FROM caregivers WHERE user_id = $1 AND deleted_at IS NULL`,
      [user_id]
    );
    
    if (parseInt(existingCount.rows[0].cnt) >= 5) {
      return res.status(409).json({
        error: 'caregiver_limit',
        message: 'มีผู้ดูแลครบ 5 คนแล้ว — ลบคนที่ไม่ใช้ก่อน'
      });
    }
    
    // Generate unique invite code (try up to 5 times)
    let inviteCode;
    let codeExists = true;
    let attempts = 0;
    while (codeExists && attempts < 5) {
      inviteCode = caregiverModule.generateInviteCode();
      const check = await db.query(
        `SELECT id FROM caregivers WHERE invite_code = $1`,
        [inviteCode]
      );
      codeExists = check.rows.length > 0;
      attempts++;
    }
    
    const result = await db.query(`
      INSERT INTO caregivers 
        (user_id, name, relationship, phone, invite_code, alert_threshold_minutes, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
      RETURNING *
    `, [user_id, name, relationship || null, phone || null, inviteCode, alert_threshold_minutes || 30]);
    
    res.json({ ok: true, caregiver: result.rows[0] });
  } catch (e) {
    console.error('[POST /api/caregivers]', e);
    res.status(500).json({ error: 'server_error', message: e.message });
  }
});

// GET /api/caregivers?user_id=X — Get user's caregivers
app.get('/api/caregivers', userLimiter, async (req, res) => {
  const userId = parseInt(req.query.user_id);
  if (!userId) return res.status(400).json({ error: 'user_id_required' });
  
  try {
    const result = await db.query(`
      SELECT 
        id, name, relationship, phone, status, invite_code,
        alert_threshold_minutes, can_confirm, receive_alerts,
        invited_at, accepted_at,
        line_user_id IS NOT NULL as is_linked
      FROM caregivers 
      WHERE user_id = $1 AND deleted_at IS NULL
    `, [userId]);
    
    res.json({ ok: true, caregivers: result.rows });
  } catch (e) {
    console.error('[GET /api/caregivers]', e);
    res.status(500).json({ error: 'server_error', message: e.message });
  }
});

// PATCH /api/caregivers/:id — Update caregiver
app.patch('/api/caregivers/:id', userLimiter, async (req, res) => {
  const cgId = parseInt(req.params.id);
  const { name, relationship, phone, alert_threshold_minutes, receive_alerts, can_confirm } = req.body || {};
  
  try {
    const updates = [];
    const values = [];
    let i = 1;
    
    if (name !== undefined) { updates.push(`name = $${i++}`); values.push(name); }
    if (relationship !== undefined) { updates.push(`relationship = $${i++}`); values.push(relationship); }
    if (phone !== undefined) { updates.push(`phone = $${i++}`); values.push(phone); }
    if (alert_threshold_minutes !== undefined) { updates.push(`alert_threshold_minutes = $${i++}`); values.push(alert_threshold_minutes); }
    if (receive_alerts !== undefined) { updates.push(`receive_alerts = $${i++}`); values.push(receive_alerts); }
    if (can_confirm !== undefined) { updates.push(`can_confirm = $${i++}`); values.push(can_confirm); }
    
    if (updates.length === 0) {
      return res.status(400).json({ error: 'no_fields_to_update' });
    }
    
    values.push(cgId);
    const result = await db.query(`
      UPDATE caregivers SET ${updates.join(', ')}
      WHERE id = $${i} AND deleted_at IS NULL
      RETURNING *
    `, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    
    res.json({ ok: true, caregiver: result.rows[0] });
  } catch (e) {
    console.error('[PATCH /api/caregivers/:id]', e);
    res.status(500).json({ error: 'server_error', message: e.message });
  }
});

// DELETE /api/caregivers/:id — Soft delete
app.delete('/api/caregivers/:id', userLimiter, async (req, res) => {
  const cgId = parseInt(req.params.id);
  
  try {
    await db.query(`
      UPDATE caregivers SET deleted_at = NOW() WHERE id = $1
    `, [cgId]);
    
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/caregivers/:id]', e);
    res.status(500).json({ error: 'server_error', message: e.message });
  }
});

// 🧪 POST /api/caregivers/:id/test-alert — Send test alert to caregiver
app.post('/api/caregivers/:id/test-alert', userLimiter, async (req, res) => {
  const cgId = parseInt(req.params.id);
  const { user_id } = req.body;
  
  if (!cgId || !user_id) {
    return res.status(400).json({ error: 'missing_params' });
  }
  
  try {
    // Get caregiver + verify linked
    const cgResult = await db.query(`
      SELECT c.id, c.name, c.line_user_id, c.relationship, u.name AS patient_name
      FROM caregivers c
      JOIN users u ON u.id = c.user_id
      WHERE c.id = $1 AND c.user_id = $2 AND c.deleted_at IS NULL
    `, [cgId, user_id]);
    
    if (cgResult.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    
    const cg = cgResult.rows[0];
    
    if (!cg.line_user_id) {
      return res.status(400).json({ 
        error: 'not_linked',
        message: 'ผู้ดูแลยังไม่ได้เชื่อมต่อ LINE' 
      });
    }
    
    // Send test Flex Message via LINE
    const testFlex = {
      type: 'flex',
      altText: '🧪 ทดสอบ Alert ผู้ดูแล',
      contents: {
        type: 'bubble',
        header: {
          type: 'box',
          layout: 'vertical',
          contents: [{
            type: 'text',
            text: '🧪 TEST — ทดสอบระบบ',
            weight: 'bold',
            color: '#ffffff',
            size: 'md'
          }],
          backgroundColor: '#f59e0b',
          paddingAll: '12px'
        },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'text',
              text: `สวัสดีคุณ ${cg.name}`,
              size: 'md',
              weight: 'bold'
            },
            {
              type: 'text',
              text: `นี่คือ test alert จาก ${cg.patient_name}`,
              size: 'sm',
              color: '#64748b',
              margin: 'sm',
              wrap: true
            },
            {
              type: 'separator',
              margin: 'md'
            },
            {
              type: 'text',
              text: '✅ ระบบทำงานปกติ',
              size: 'sm',
              color: '#10b981',
              weight: 'bold',
              margin: 'md',
              align: 'center'
            },
            {
              type: 'text',
              text: 'หากผู้ป่วยลืมยาจริง คุณจะได้รับแจ้งเตือนแบบนี้',
              size: 'xs',
              color: '#94a3b8',
              wrap: true,
              margin: 'sm',
              align: 'center'
            }
          ],
          paddingAll: '16px'
        }
      }
    };
    
    await lineClient.pushMessage(cg.line_user_id, testFlex);
    
    console.log(`[test-alert] sent to caregiver ${cgId} (${cg.name})`);
    res.json({ ok: true, message: 'Test alert sent' });
    
  } catch (e) {
    console.error('[test-alert]', e);
    res.status(500).json({ error: 'server_error', message: e.message });
  }
});

// ════════════════════════════════════════════════════════
//  END PHASE 2
// ════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════
//  PATH B: LINE-BASED IDENTITY (Session 8)
//  - GET /api/users/by-line-id/:lineUserId
//  - POST /api/users/onboard (full profile creation)
//  Enables multi-user via LINE OA — friend testing ready!
// ════════════════════════════════════════════════════════

// GET /api/users/by-line-id/:lineUserId — Lookup user by LINE ID
app.get('/api/users/by-line-id/:lineUserId', userLimiter, async (req, res) => {
  const { lineUserId } = req.params;
  
  // Validate LINE User ID format (33 chars: 'U' + 32 hex)
  if (!lineUserId || !lineUserId.match(/^U[a-f0-9]{32}$/)) {
    return res.status(400).json({ ok: false, error: 'invalid_line_user_id' });
  }
  
  try {
    const result = await db.query(`
      SELECT id, name, age, gender, phone, line_user_id,
             breakfast_time, lunch_time, dinner_time, bedtime,
             push_lead_minutes, chronic_conditions,
             onboarded_at, created_at
      FROM users
      WHERE line_user_id = $1 AND deleted_at IS NULL
    `, [lineUserId]);
    
    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: 'user_not_found' });
    }
    
    res.json({ ok: true, user: result.rows[0] });
  } catch (e) {
    console.error('[GET /api/users/by-line-id/:id]', e);
    res.status(500).json({ ok: false, error: 'server_error', message: e.message });
  }
});

// POST /api/users/onboard — Create new user from onboarding
app.post('/api/users/onboard', userLimiter, async (req, res) => {
  const { 
    line_user_id, name, age, gender, phone,
    breakfast_time, lunch_time, dinner_time, bedtime,
    push_lead_minutes, chronic_conditions
  } = req.body || {};
  
  // Validate required fields
  if (!line_user_id || !name) {
    return res.status(400).json({ 
      ok: false, 
      error: 'missing_required_fields',
      message: 'line_user_id and name are required'
    });
  }
  
  // Validate LINE User ID format
  if (!line_user_id.match(/^U[a-f0-9]{32}$/)) {
    return res.status(400).json({ ok: false, error: 'invalid_line_user_id' });
  }
  
  try {
    // Check if user already exists
    const existing = await db.query(
      'SELECT id, name FROM users WHERE line_user_id = $1 AND deleted_at IS NULL',
      [line_user_id]
    );
    
    if (existing.rows.length > 0) {
      return res.status(409).json({ 
        ok: false,
        error: 'user_exists',
        message: 'A user with this LINE ID already exists',
        user_id: existing.rows[0].id,
        user_name: existing.rows[0].name
      });
    }
    
    // Create user
    const result = await db.query(`
      INSERT INTO users 
        (line_user_id, name, age, gender, phone,
         breakfast_time, lunch_time, dinner_time, bedtime,
         push_lead_minutes, chronic_conditions, onboarded_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      RETURNING *
    `, [
      line_user_id, 
      name.trim(),
      age || null, 
      gender || null, 
      phone || null,
      breakfast_time || '07:00', 
      lunch_time || '12:00',
      dinner_time || '18:00', 
      bedtime || '21:00',
      push_lead_minutes || 0, 
      Array.isArray(chronic_conditions) ? chronic_conditions : []
    ]);
    
    console.log('[onboard] Created user:', result.rows[0].id, result.rows[0].name);
    res.json({ ok: true, user: result.rows[0] });
  } catch (e) {
    console.error('[POST /api/users/onboard]', e);
    res.status(500).json({ ok: false, error: 'server_error', message: e.message });
  }
});

// ════════════════════════════════════════════════════════
//  END PATH B
// ════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════
//  PHASE 5: APPOINTMENTS CRUD (Session 9)
//  Save scanned + verified appointment data
//  Send LINE reminders 7/3/1 days before
// ════════════════════════════════════════════════════════

// POST /api/appointments — Create new appointment
app.post('/api/appointments', userLimiter, async (req, res) => {
  const {
    user_id,
    patient_name, hn,
    hospital_name, department, building,
    doctor_name,
    appointment_date,  // YYYY-MM-DD
    appointment_time,
    instructions,
    note,
    ai_confidence,
    ai_raw_data,
  } = req.body || {};
  
  if (!user_id || !appointment_date) {
    return res.status(400).json({ 
      error: 'missing_required', 
      message: 'user_id and appointment_date are required' 
    });
  }
  
  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(appointment_date)) {
    return res.status(400).json({ 
      error: 'invalid_date', 
      message: 'appointment_date must be YYYY-MM-DD' 
    });
  }
  
  try {
    const result = await db.query(
      `INSERT INTO appointments 
       (user_id, patient_name, hn, hospital_name, department, building,
        doctor_name, appointment_date, appointment_time, 
        instructions, note, ai_confidence, ai_raw_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        user_id,
        patient_name || null,
        hn || null,
        hospital_name || null,
        department || null,
        building || null,
        doctor_name || null,
        appointment_date,
        appointment_time || null,
        instructions || [],
        note || null,
        ai_confidence || null,
        ai_raw_data ? JSON.stringify(ai_raw_data) : null,
      ]
    );
    
    console.log('[appointments] created id=', result.rows[0].id, 'for user=', user_id);
    res.json({ ok: true, appointment: result.rows[0] });
  } catch (e) {
    console.error('[appointments] create error:', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// GET /api/appointments — List user's appointments
app.get('/api/appointments', userLimiter, async (req, res) => {
  const userId = parseInt(req.query.user_id);
  if (!userId) return res.status(400).json({ error: 'missing_user_id' });
  
  // Optional filter: only future appointments
  const futureOnly = req.query.future === 'true';
  
  try {
    let query = `SELECT * FROM appointments 
                 WHERE user_id = $1 AND deleted_at IS NULL`;
    const params = [userId];
    
    if (futureOnly) {
      query += ` AND appointment_date >= CURRENT_DATE`;
    }
    
    query += ` ORDER BY appointment_date ASC, appointment_time ASC`;
    
    const result = await db.query(query, params);
    res.json({ ok: true, appointments: result.rows });
  } catch (e) {
    console.error('[appointments] list error:', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// GET /api/appointments/:id — Get single appointment
app.get('/api/appointments/:id', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  
  try {
    const result = await db.query(
      `SELECT * FROM appointments WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    res.json({ ok: true, appointment: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// PATCH /api/appointments/:id — Update appointment
app.patch('/api/appointments/:id', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  
  const allowedFields = [
    'patient_name', 'hn', 'hospital_name', 'department', 'building',
    'doctor_name', 'appointment_date', 'appointment_time',
    'instructions', 'note'
  ];
  
  const updates = [];
  const values = [];
  let paramIdx = 1;
  
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = $${paramIdx}`);
      values.push(req.body[field]);
      paramIdx++;
    }
  }
  
  if (updates.length === 0) {
    return res.status(400).json({ error: 'no_updates' });
  }
  
  updates.push(`updated_at = NOW()`);
  values.push(id);
  
  try {
    const result = await db.query(
      `UPDATE appointments SET ${updates.join(', ')} 
       WHERE id = $${paramIdx} AND deleted_at IS NULL
       RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    
    res.json({ ok: true, appointment: result.rows[0] });
  } catch (e) {
    console.error('[appointments] update error:', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// DELETE /api/appointments/:id — Soft delete
app.delete('/api/appointments/:id', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  
  try {
    const result = await db.query(
      `UPDATE appointments SET deleted_at = NOW() 
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    
    res.json({ ok: true, deleted: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// ════════════════════════════════════════════════════════
//  END PHASE 5 APPOINTMENTS
// ════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════
//  PHASE 5+: SCAN HISTORY ("ตู้ยาของฉัน") (Session 10)
//  Track every scan with thumbnail + AI data
//  Provides timeline / hospital / medication views
// ════════════════════════════════════════════════════════

// POST /api/scan-history — Save scan record
app.post('/api/scan-history', userLimiter, async (req, res) => {
  const {
    user_id, scan_type,
    hospital_name, doctor_name,
    image_thumbnail, ai_raw_data, ai_confidence,
    medication_ids, appointment_id,
    user_note,
  } = req.body || {};
  
  if (!user_id || !scan_type) {
    return res.status(400).json({ 
      error: 'missing_required', 
      message: 'user_id and scan_type are required' 
    });
  }
  
  if (!['medication', 'appointment'].includes(scan_type)) {
    return res.status(400).json({ 
      error: 'invalid_scan_type', 
      message: 'scan_type must be "medication" or "appointment"' 
    });
  }
  
  try {
    const result = await db.query(
      `INSERT INTO scan_history 
       (user_id, scan_type, hospital_name, doctor_name,
        image_thumbnail, ai_raw_data, ai_confidence,
        medication_ids, appointment_id, user_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, scan_date, scan_type, hospital_name, doctor_name`,
      [
        user_id, scan_type,
        hospital_name || null,
        doctor_name || null,
        image_thumbnail || null,
        ai_raw_data ? JSON.stringify(ai_raw_data) : null,
        ai_confidence || null,
        medication_ids || null,
        appointment_id || null,
        user_note || null,
      ]
    );
    
    console.log('[scan-history] saved id=', result.rows[0].id, 'type=', scan_type, 'user=', user_id);
    res.json({ ok: true, scan: result.rows[0] });
  } catch (e) {
    console.error('[scan-history] save error:', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// GET /api/scan-history — List user's scans (with optional grouping)
app.get('/api/scan-history', userLimiter, async (req, res) => {
  const userId = parseInt(req.query.user_id);
  if (!userId) return res.status(400).json({ error: 'missing_user_id' });
  
  const groupBy = req.query.group_by || 'date';  // date|hospital|medication
  const scanType = req.query.scan_type;  // optional filter
  
  try {
    let baseQuery = `
      SELECT 
        sh.id, sh.scan_date, sh.scan_type,
        sh.hospital_name, sh.doctor_name,
        sh.image_thumbnail IS NOT NULL AS has_thumbnail,
        sh.ai_confidence, sh.user_note,
        sh.medication_ids, sh.appointment_id,
        sh.ai_raw_data
      FROM scan_history sh
      WHERE sh.user_id = $1 AND sh.deleted_at IS NULL
    `;
    const params = [userId];
    
    if (scanType) {
      baseQuery += ` AND sh.scan_type = $${params.length + 1}`;
      params.push(scanType);
    }
    
    baseQuery += ` ORDER BY sh.scan_date DESC`;
    
    const result = await db.query(baseQuery, params);
    
    // For medication scans, enrich with medication names
    const enrichedScans = await Promise.all(result.rows.map(async (scan) => {
      if (scan.scan_type === 'medication' && scan.medication_ids && scan.medication_ids.length > 0) {
        try {
          const medsResult = await db.query(
            `SELECT id, drug_name as name, drug_name_raw, dose_mg as dose_value, dose_unit FROM medications 
             WHERE id = ANY($1) AND deleted_at IS NULL`,
            [scan.medication_ids]
          );
          scan.medications = medsResult.rows;
        } catch (e) {
          scan.medications = [];
        }
      }
      return scan;
    }));
    
    // Group by request
    let grouped;
    if (groupBy === 'hospital') {
      grouped = {};
      for (const scan of enrichedScans) {
        const key = scan.hospital_name || 'ไม่ระบุโรงพยาบาล';
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(scan);
      }
      grouped = Object.entries(grouped).map(([hospital, scans]) => ({
        hospital,
        count: scans.length,
        latest_date: scans[0].scan_date,
        scans,
      }));
      res.json({ ok: true, group_by: 'hospital', groups: grouped });
    } else if (groupBy === 'medication') {
      // Aggregate by medication name (across scans)
      grouped = {};
      for (const scan of enrichedScans) {
        if (scan.scan_type !== 'medication' || !scan.medications) continue;
        for (const med of scan.medications) {
          const key = med.name;
          if (!grouped[key]) {
            grouped[key] = {
              name: med.name,
              dose_value: med.dose_value,
              dose_unit: med.dose_unit,
              scan_count: 0,
              first_scan: scan.scan_date,
              latest_scan: scan.scan_date,
              hospitals: new Set(),
              doctors: new Set(),
              scan_ids: [],
            };
          }
          grouped[key].scan_count++;
          grouped[key].latest_scan = scan.scan_date;
          if (scan.hospital_name) grouped[key].hospitals.add(scan.hospital_name);
          if (scan.doctor_name) grouped[key].doctors.add(scan.doctor_name);
          grouped[key].scan_ids.push(scan.id);
        }
      }
      // Convert Sets to arrays
      grouped = Object.values(grouped).map(g => ({
        ...g,
        hospitals: Array.from(g.hospitals),
        doctors: Array.from(g.doctors),
      }));
      res.json({ ok: true, group_by: 'medication', medications: grouped });
    } else {
      // Default: group by date (timeline)
      res.json({ ok: true, group_by: 'date', scans: enrichedScans });
    }
  } catch (e) {
    console.error('[scan-history] list error:', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// GET /api/scan-history/:id — Get single scan with full details (including thumbnail)
app.get('/api/scan-history/:id', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  
  try {
    const result = await db.query(
      `SELECT * FROM scan_history WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    
    const scan = result.rows[0];
    
    // Enrich with medication names
    if (scan.scan_type === 'medication' && scan.medication_ids && scan.medication_ids.length > 0) {
      const medsResult = await db.query(
        `SELECT id, drug_name as name, drug_name_raw, dose_mg as dose_value, dose_unit 
         FROM medications 
         WHERE id = ANY($1) AND deleted_at IS NULL`,
        [scan.medication_ids]
      );
      scan.medications = medsResult.rows;
    }
    
    // Enrich with appointment data
    if (scan.scan_type === 'appointment' && scan.appointment_id) {
      const apptResult = await db.query(
        `SELECT * FROM appointments WHERE id = $1 AND deleted_at IS NULL`,
        [scan.appointment_id]
      );
      if (apptResult.rows.length > 0) {
        scan.appointment = apptResult.rows[0];
      }
    }
    
    res.json({ ok: true, scan });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// PATCH /api/scan-history/:id — Update note
app.patch('/api/scan-history/:id', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  
  const { user_note } = req.body || {};
  
  try {
    const result = await db.query(
      `UPDATE scan_history SET user_note = $1
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING id, user_note`,
      [user_note || null, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    
    res.json({ ok: true, scan: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// DELETE /api/scan-history/:id — Soft delete
app.delete('/api/scan-history/:id', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  
  try {
    const result = await db.query(
      `UPDATE scan_history SET deleted_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    
    res.json({ ok: true, deleted: true });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// ════════════════════════════════════════════════════════
//  END PHASE 5+ SCAN HISTORY
// ════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════
//  LAYER 7: REAL REFILL (Phase 4) — Session 11
//  Calculate remaining tablets from doses + alert at 7/3/0 days
// ════════════════════════════════════════════════════════

// Helper: Calculate remaining tablets for a single medication
async function calculateMedicationRefill(med) {
  // Need: total_tablets, start_date, schedules (to know consumption)
  if (!med.total_tablets || !med.start_date) {
    return {
      medication_id: med.id,
      name: med.name,
      total_tablets: med.total_tablets,
      start_date: med.start_date,
      tablets_remaining: null,
      days_remaining: null,
      status: 'unknown',  // not enough data
    };
  }
  
  try {
    // Get number of doses logged (taken) for this medication
    const dosesResult = await db.query(
      `SELECT COUNT(*) as taken_count 
       FROM dose_logs 
       WHERE medication_id = $1 
         AND status IN ('taken', 'late')`,
      [med.id]
    );

    // Sum tablets per day across ALL active schedules (multi-dose aware)
    // Each schedule has its own tablets_per_dose (e.g. เช้า 2 + เย็น 1 = 3/day)
    const schedAgg = await db.query(
      `SELECT 
         COUNT(*) AS schedule_count,
         COALESCE(SUM(tablets_per_dose), 0) AS tablets_per_day
       FROM dose_schedules 
       WHERE medication_id = $1 AND is_active = TRUE`,
      [med.id]
    );
    const dosesPerDay = parseInt(schedAgg.rows[0].schedule_count) || 1;
    const tabletsPerDay = parseFloat(schedAgg.rows[0].tablets_per_day) || dosesPerDay;
    // Average tablets per dose (for consumption estimate from dose_logs count)
    const avgTabletsPerDose = dosesPerDay > 0 ? tabletsPerDay / dosesPerDay : 1;

    const dosesTaken = parseInt(dosesResult.rows[0].taken_count) || 0;
    const tabletsTaken = dosesTaken * avgTabletsPerDose;
    const tabletsRemaining = Math.max(0, med.total_tablets - tabletsTaken);
    
    const daysRemaining = tabletsPerDay > 0 
      ? Math.floor(tabletsRemaining / tabletsPerDay) 
      : null;
    
    // Status indicator
    let status = 'ok';
    if (daysRemaining !== null) {
      if (daysRemaining <= 0) status = 'expired';
      else if (daysRemaining <= 3) status = 'critical';
      else if (daysRemaining <= 7) status = 'warning';
      else status = 'ok';
    }
    
    return {
      medication_id: med.id,
      name: med.name,
      dose_value: med.dose_value,
      dose_unit: med.dose_unit,
      total_tablets: med.total_tablets,
      tablets_taken: tabletsTaken,
      tablets_remaining: tabletsRemaining,
      tablets_per_day: tabletsPerDay,
      days_remaining: daysRemaining,
      status: status,
      start_date: med.start_date,
    };
  } catch (e) {
    console.error('[refill] calc error for med', med.id, ':', e.message);
    return {
      medication_id: med.id,
      name: med.name,
      status: 'error',
      error: e.message,
    };
  }
}

// GET /api/medications/refill-status — All medications with refill info
app.get('/api/medications/refill-status', userLimiter, async (req, res) => {
  const userId = parseInt(req.query.user_id);
  if (!userId) return res.status(400).json({ error: 'missing_user_id' });
  
  try {
    const result = await db.query(
      `SELECT id, drug_name as name, drug_name_raw, dose_mg as dose_value, dose_unit,
              total_tablets, start_date, hospital_name, doctor_name
       FROM medications 
       WHERE user_id = $1 AND deleted_at IS NULL AND is_active = TRUE
       ORDER BY drug_name`,
      [userId]
    );
    
    const medications = await Promise.all(
      result.rows.map(med => calculateMedicationRefill(med))
    );
    
    // Summary stats
    const summary = {
      total: medications.length,
      ok: medications.filter(m => m.status === 'ok').length,
      warning: medications.filter(m => m.status === 'warning').length,
      critical: medications.filter(m => m.status === 'critical').length,
      expired: medications.filter(m => m.status === 'expired').length,
      unknown: medications.filter(m => m.status === 'unknown').length,
    };
    
    res.json({ ok: true, summary, medications });
  } catch (e) {
    console.error('[refill-status] error:', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// PATCH /api/medications/:id/refill — Update refill info (start_date + total_tablets)
app.patch('/api/medications/:id/refill', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  
  const { start_date, total_tablets } = req.body || {};
  
  try {
    const result = await db.query(
      `UPDATE medications 
       SET start_date = COALESCE($1, start_date),
           total_tablets = COALESCE($2, total_tablets),
           updated_at = NOW()
       WHERE id = $3 AND deleted_at IS NULL
       RETURNING id, drug_name as name, start_date, total_tablets`,
      [start_date || null, total_tablets || null, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    
    res.json({ ok: true, medication: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// CRON: Daily refill check at 09:00 Asia/Bangkok
function runRefillCheck() {
  console.log('[refill-cron] Running daily refill check...');
  (async () => {
    try {
      // Get all active medications with refill info
      const meds = await db.query(
        `SELECT m.id, m.user_id, m.drug_name as name,
                m.total_tablets, m.start_date, u.line_user_id 
         FROM medications m
         JOIN users u ON u.id = m.user_id
         WHERE m.deleted_at IS NULL 
           AND m.is_active = TRUE
           AND m.total_tablets IS NOT NULL
           AND m.start_date IS NOT NULL
           AND u.line_user_id IS NOT NULL`,
        []
      );
      
      let alertsSent = 0;
      
      for (const med of meds.rows) {
        const status = await calculateMedicationRefill(med);
        
        if (!status.days_remaining && status.days_remaining !== 0) continue;
        
        // Determine alert type
        let alertType = null;
        let messageText = null;
        
        if (status.days_remaining === 0 || status.days_remaining < 0) {
          alertType = 'expired';
          messageText = `⚠️ ${med.name} หมดแล้ว!\n\nกรุณานัดหมายแพทย์เพื่อขอยา refill ครับ\n\n📊 ข้อมูลยา:\n• เริ่มกิน: ${new Date(med.start_date).toLocaleDateString('th-TH')}\n• ทั้งหมด: ${med.total_tablets} เม็ด\n• กินไปแล้ว: ${status.tablets_taken} เม็ด`;
        } else if (status.days_remaining <= 3) {
          alertType = '3days';
          messageText = `⏰ ${med.name} เหลือ ${status.tablets_remaining} เม็ด — พอกินอีก ${status.days_remaining} วันเท่านั้น!\n\nกรุณานัดหมายแพทย์เพื่อ refill ครับ`;
        } else if (status.days_remaining <= 7) {
          alertType = '7days';
          messageText = `📅 ${med.name} จะหมดในอีก ${status.days_remaining} วัน\n\nควรเริ่มวางแผนนัดหมายแพทย์เพื่อรับยา refill`;
        }
        
        if (!alertType) continue;
        
        // Check if alert already sent (prevent duplicate)
        const existing = await db.query(
          `SELECT id FROM refill_logs 
           WHERE medication_id = $1 AND alert_type = $2`,
          [med.id, alertType]
        );
        
        if (existing.rows.length > 0) {
          console.log(`[refill-cron] Skip ${med.name} — ${alertType} already sent`);
          continue;
        }
        
        // Send LINE message
        try {
          await lineClient.pushMessage(med.line_user_id, {
            type: 'text',
            text: messageText
          });
          
          // Log
          await db.query(
            `INSERT INTO refill_logs (medication_id, user_id, alert_type, days_left)
             VALUES ($1, $2, $3, $4)`,
            [med.id, med.user_id, alertType, status.days_remaining]
          );
          
          alertsSent++;
          console.log(`[refill-cron] ✅ Sent ${alertType} alert for ${med.name} (user ${med.user_id})`);
        } catch (e) {
          console.error(`[refill-cron] Failed to send for ${med.name}:`, e.message);
        }
      }
      
      console.log(`[refill-cron] Done. Alerts sent: ${alertsSent}/${meds.rows.length}`);
    } catch (e) {
      console.error('[refill-cron] Error:', e.message);
    }
  })();
}

// Schedule cron: 09:00 daily Asia/Bangkok
cron.schedule('0 9 * * *', runRefillCheck, { timezone: 'Asia/Bangkok' });
console.log('✅ Refill check cron started (daily 09:00 Asia/Bangkok)');

// Manual trigger endpoint (for testing)
app.post('/api/admin/run-refill-check', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (secret !== process.env.SCHEDULER_TRIGGER_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  runRefillCheck();
  res.json({ ok: true, message: 'Refill check triggered' });
});

// ════════════════════════════════════════════════════════
//  ADMIN DASHBOARD ENDPOINTS
// ════════════════════════════════════════════════════════

// GET /api/admin/overview — Full system overview
app.get('/api/admin/overview', async (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== process.env.SCHEDULER_TRIGGER_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  
  try {
    // Users with last activity + adherence
    // NOTE: dose_logs uses confirmed_at (not taken_at)
    const usersResult = await db.query(`
      SELECT 
        u.id,
        u.name AS display_name,
        u.line_user_id,
        u.phone,
        u.created_at,
        (SELECT MAX(confirmed_at) FROM dose_logs WHERE user_id = u.id AND status = 'taken') AS last_dose,
        (SELECT COUNT(*) FROM medications WHERE user_id = u.id AND deleted_at IS NULL AND is_active = TRUE) AS active_meds,
        (SELECT COUNT(*) FROM appointments WHERE user_id = u.id AND deleted_at IS NULL AND appointment_date >= CURRENT_DATE) AS upcoming_appts,
        (SELECT COUNT(*) FROM scan_history WHERE user_id = u.id AND deleted_at IS NULL) AS total_scans,
        (
          SELECT ROUND(
            100.0 * SUM(CASE WHEN status = 'taken' THEN 1 ELSE 0 END) 
            / NULLIF(COUNT(*), 0), 1
          )
          FROM dose_logs 
          WHERE user_id = u.id 
          AND scheduled_at > NOW() - INTERVAL '7 days'
        ) AS adherence_7d,
        (
          SELECT ROUND(
            100.0 * SUM(CASE WHEN status = 'taken' THEN 1 ELSE 0 END) 
            / NULLIF(COUNT(*), 0), 1
          )
          FROM dose_logs 
          WHERE user_id = u.id 
          AND scheduled_at > NOW() - INTERVAL '30 days'
        ) AS adherence_30d
      FROM users u
      WHERE u.deleted_at IS NULL
      ORDER BY u.created_at DESC
    `);
    
    // System stats
    const statsResult = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS total_users,
        (SELECT COUNT(*) FROM medications WHERE deleted_at IS NULL AND is_active = TRUE) AS total_meds,
        (SELECT COUNT(*) FROM appointments WHERE deleted_at IS NULL AND appointment_date >= CURRENT_DATE) AS upcoming_appts,
        (SELECT COUNT(*) FROM scan_history WHERE deleted_at IS NULL) AS total_scans,
        (SELECT COUNT(*) FROM dose_logs WHERE confirmed_at > NOW() - INTERVAL '24 hours') AS doses_24h,
        (SELECT COUNT(*) FROM dose_logs WHERE status = 'taken' AND confirmed_at > NOW() - INTERVAL '24 hours') AS taken_24h,
        (SELECT COUNT(*) FROM caregivers WHERE deleted_at IS NULL AND status = 'active') AS active_caregivers
    `);
    
    // Recent activity (last 20 events)
    const activityResult = await db.query(`
      (
        SELECT 
          'dose' AS event_type,
          dl.confirmed_at AS event_time,
          u.name AS display_name,
          u.id AS user_id,
          COALESCE(dl.status, 'pending') AS detail
        FROM dose_logs dl
        JOIN users u ON u.id = dl.user_id
        WHERE dl.confirmed_at IS NOT NULL
        ORDER BY dl.confirmed_at DESC
        LIMIT 10
      )
      UNION ALL
      (
        SELECT 
          'scan' AS event_type,
          sh.created_at AS event_time,
          u.name AS display_name,
          u.id AS user_id,
          sh.scan_type AS detail
        FROM scan_history sh
        JOIN users u ON u.id = sh.user_id
        WHERE sh.deleted_at IS NULL
        ORDER BY sh.created_at DESC
        LIMIT 10
      )
      ORDER BY event_time DESC
      LIMIT 20
    `);
    
    res.json({
      ok: true,
      stats: statsResult.rows[0],
      users: usersResult.rows,
      activity: activityResult.rows,
      generated_at: new Date().toISOString()
    });
  } catch (e) {
    console.error('[admin-overview] error:', e);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// GET /api/admin/user/:id — User detail
app.get('/api/admin/user/:id', async (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== process.env.SCHEDULER_TRIGGER_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  
  const userId = parseInt(req.params.id);
  if (!userId) return res.status(400).json({ error: 'invalid_id' });
  
  try {
    const userResult = await db.query(
      `SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    
    const medsResult = await db.query(`
      SELECT 
        id, drug_name, dose_mg, dose_unit,
        start_date, total_tablets, is_active, created_at
      FROM medications
      WHERE user_id = $1 AND deleted_at IS NULL
      ORDER BY is_active DESC, created_at DESC
    `, [userId]);
    
    const apptsResult = await db.query(`
      SELECT id, hospital_name, doctor_name, department, appointment_date, appointment_time
      FROM appointments
      WHERE user_id = $1 AND deleted_at IS NULL
      ORDER BY appointment_date DESC
    `, [userId]);
    
    const recentDosesResult = await db.query(`
      SELECT 
        dl.id, dl.scheduled_at, dl.confirmed_at, dl.status,
        m.drug_name
      FROM dose_logs dl
      LEFT JOIN medications m ON m.id = dl.medication_id
      WHERE dl.user_id = $1
      ORDER BY dl.scheduled_at DESC
      LIMIT 30
    `, [userId]);
    
    res.json({
      ok: true,
      user: userResult.rows[0],
      medications: medsResult.rows,
      appointments: apptsResult.rows,
      recent_doses: recentDosesResult.rows
    });
  } catch (e) {
    console.error('[admin-user] error:', e);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// 📥 GET /api/admin/export-diagnostics — CSV export of all tables for debugging
app.get('/api/admin/export-diagnostics', async (req, res) => {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (secret !== process.env.SCHEDULER_TRIGGER_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  
  // Helper: convert array of objects to CSV
  function toCSV(rows, label) {
    if (!rows || rows.length === 0) {
      return `=== ${label} ===\n(empty)\n\n`;
    }
    const headers = Object.keys(rows[0]);
    const csvRows = [
      `=== ${label} (${rows.length} rows) ===`,
      headers.join(','),
      ...rows.map(r => headers.map(h => {
        let v = r[h];
        if (v === null || v === undefined) return '';
        if (typeof v === 'object') v = JSON.stringify(v);
        v = String(v).replace(/"/g, '""');
        return v.includes(',') || v.includes('\n') || v.includes('"') ? `"${v}"` : v;
      }).join(','))
    ];
    return csvRows.join('\n') + '\n\n';
  }
  
  try {
    // Run all 4 queries
    const [users, medications, schedules, scans, caregivers] = await Promise.all([
      db.query(`
        SELECT id, name, line_user_id, phone, age, gender, 
               created_at, deleted_at
        FROM users ORDER BY id
      `),
      db.query(`
        SELECT m.id, m.user_id, u.name AS owner, m.drug_name, 
               m.drug_name_en, m.dose_mg, m.dose_unit, 
               m.is_active, m.deleted_at, m.created_at
        FROM medications m
        LEFT JOIN users u ON u.id = m.user_id
        ORDER BY m.user_id, m.id
      `),
      db.query(`
        SELECT ds.id, ds.user_id, ds.medication_id,
               m.drug_name, ds.reminder_time, ds.meal_anchor,
               ds.is_active AS sched_active,
               m.is_active AS med_active, m.deleted_at AS med_deleted
        FROM dose_schedules ds
        LEFT JOIN medications m ON m.id = ds.medication_id
        ORDER BY ds.user_id, ds.medication_id, ds.id
      `),
      db.query(`
        SELECT id, user_id, scan_type, scan_date, 
               hospital_name, ai_confidence, deleted_at
        FROM scan_history ORDER BY user_id, id
      `),
      db.query(`
        SELECT id, user_id, name, relationship, 
               line_user_id, status, deleted_at
        FROM caregivers ORDER BY user_id
      `)
    ]);
    
    let csv = '';
    csv += `MedTrack Diagnostics Export — ${new Date().toISOString()}\n\n`;
    csv += toCSV(users.rows, 'USERS');
    csv += toCSV(medications.rows, 'MEDICATIONS');
    csv += toCSV(schedules.rows, 'DOSE_SCHEDULES');
    csv += toCSV(scans.rows, 'SCAN_HISTORY');
    csv += toCSV(caregivers.rows, 'CAREGIVERS');
    
    // Set CSV download headers
    const filename = `medtrack-diag-${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.write('\ufeff'); // BOM for Excel Thai support
    res.end(csv);
    
  } catch (e) {
    console.error('[export-diagnostics] error:', e);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// ════════════════════════════════════════════════════════
//  END LAYER 7 REFILL
// ════════════════════════════════════════════════════════


// ════════════════════════════════════════════════════════
//  LAYER 9 — LINE LOGIN (OAuth 2.0)
// ════════════════════════════════════════════════════════

const LINE_LOGIN_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID;
const LINE_LOGIN_CHANNEL_SECRET = process.env.LINE_LOGIN_CHANNEL_SECRET;
const LINE_LOGIN_CALLBACK_URL = process.env.LINE_LOGIN_CALLBACK_URL 
  || 'https://app.medtrackq.com/medtrack-app/medtrack-auth-callback.html';

// Simple in-memory state store (production = Redis)
// State token → user_id mapping for CSRF prevention
const loginStateStore = new Map();

// Cleanup old states every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of loginStateStore.entries()) {
    if (now - data.created > 10 * 60 * 1000) {
      loginStateStore.delete(state);
    }
  }
}, 10 * 60 * 1000);

// 🔐 GET /api/auth/line/login — Generate state + redirect URL
app.get('/api/auth/line/login', async (req, res) => {
  if (!LINE_LOGIN_CHANNEL_ID) {
    return res.status(500).json({ 
      error: 'config_missing', 
      message: 'LINE_LOGIN_CHANNEL_ID not set' 
    });
  }
  
  // Generate random state token
  const state = require('crypto').randomBytes(16).toString('hex');
  loginStateStore.set(state, { created: Date.now() });
  
  // LINE OAuth authorization URL
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: LINE_LOGIN_CHANNEL_ID,
    redirect_uri: LINE_LOGIN_CALLBACK_URL,
    state: state,
    scope: 'profile openid',
    bot_prompt: 'aggressive'  // Prompt user to add หมอน้อย
  });
  
  const authUrl = `https://access.line.me/oauth2/v2.1/authorize?${params}`;
  
  res.json({
    ok: true,
    auth_url: authUrl,
    state: state
  });
});

// 🔐 POST /api/auth/line/callback — Exchange code for token + login user
app.post('/api/auth/line/callback', async (req, res) => {
  const { code, state } = req.body;
  
  if (!code || !state) {
    return res.status(400).json({ 
      error: 'missing_params', 
      message: 'code and state required' 
    });
  }
  
  // Verify state (CSRF prevention)
  if (!loginStateStore.has(state)) {
    return res.status(400).json({ 
      error: 'invalid_state', 
      message: 'State mismatch or expired' 
    });
  }
  loginStateStore.delete(state);
  
  if (!LINE_LOGIN_CHANNEL_ID || !LINE_LOGIN_CHANNEL_SECRET) {
    return res.status(500).json({ error: 'config_missing' });
  }
  
  try {
    // Step 1: Exchange code for access token
    const tokenResp = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: LINE_LOGIN_CALLBACK_URL,
        client_id: LINE_LOGIN_CHANNEL_ID,
        client_secret: LINE_LOGIN_CHANNEL_SECRET
      })
    });
    
    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      console.error('[auth/line] token exchange failed:', errText);
      return res.status(401).json({ 
        error: 'token_exchange_failed',
        message: errText
      });
    }
    
    const tokenData = await tokenResp.json();
    const accessToken = tokenData.access_token;
    
    // Step 2: Get user profile from LINE
    const profileResp = await fetch('https://api.line.me/v2/profile', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    if (!profileResp.ok) {
      return res.status(401).json({ error: 'profile_fetch_failed' });
    }
    
    const lineProfile = await profileResp.json();
    const lineUserId = lineProfile.userId;
    const displayName = lineProfile.displayName;
    const pictureUrl = lineProfile.pictureUrl;
    
    console.log(`[auth/line] login success: ${displayName} (${lineUserId})`);
    
    // Step 3: Find existing user OR create new
    let user;
    const existing = await db.query(
      'SELECT * FROM users WHERE line_user_id = $1 AND deleted_at IS NULL',
      [lineUserId]
    );
    
    if (existing.rows.length > 0) {
      user = existing.rows[0];
      console.log(`[auth/line] existing user id=${user.id} ${user.name}`);
    } else {
      // Create new user with LINE name
      const insertResult = await db.query(`
        INSERT INTO users (line_user_id, name, breakfast_time, lunch_time, dinner_time, bedtime, push_lead_minutes, timezone)
        VALUES ($1, $2, '07:00', '12:00', '18:00', '21:00', 15, 'Asia/Bangkok')
        RETURNING *
      `, [lineUserId, displayName]);
      user = insertResult.rows[0];
      console.log(`[auth/line] created new user id=${user.id} ${user.name}`);
    }
    
    // Step 4: Generate simple session token (signed with channel secret)
    // Format: base64(user_id.timestamp.signature)
    const crypto = require('crypto');
    const timestamp = Date.now();
    const payload = `${user.id}.${timestamp}`;
    const signature = crypto
      .createHmac('sha256', LINE_LOGIN_CHANNEL_SECRET)
      .update(payload)
      .digest('hex');
    const sessionToken = Buffer.from(`${payload}.${signature}`).toString('base64url');
    
    // Return user + session token
    res.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        line_user_id: user.line_user_id,
        picture_url: pictureUrl,
        age: user.age,
        gender: user.gender,
        phone: user.phone,
        breakfast_time: user.breakfast_time,
        lunch_time: user.lunch_time,
        dinner_time: user.dinner_time,
        bedtime: user.bedtime,
        is_new: existing.rows.length === 0
      },
      session_token: sessionToken,
      expires_in: 30 * 24 * 60 * 60  // 30 days
    });
    
  } catch (e) {
    console.error('[auth/line/callback] error:', e);
    res.status(500).json({ error: 'server_error', message: e.message });
  }
});

// 🔓 POST /api/auth/verify — Verify session token
app.post('/api/auth/verify', async (req, res) => {
  const { session_token } = req.body;
  if (!session_token) {
    return res.status(400).json({ error: 'missing_token' });
  }
  
  try {
    // Decode token
    const decoded = Buffer.from(session_token, 'base64url').toString();
    const parts = decoded.split('.');
    if (parts.length !== 3) {
      return res.status(401).json({ error: 'invalid_token' });
    }
    
    const [userId, timestamp, signature] = parts;
    const payload = `${userId}.${timestamp}`;
    
    // Verify signature
    const crypto = require('crypto');
    const expected = crypto
      .createHmac('sha256', LINE_LOGIN_CHANNEL_SECRET)
      .update(payload)
      .digest('hex');
    
    if (signature !== expected) {
      return res.status(401).json({ error: 'invalid_signature' });
    }
    
    // Check expiry (30 days)
    const age = Date.now() - parseInt(timestamp);
    if (age > 30 * 24 * 60 * 60 * 1000) {
      return res.status(401).json({ error: 'token_expired' });
    }
    
    // Get user
    const result = await db.query(
      'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL',
      [parseInt(userId)]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'user_not_found' });
    }
    
    res.json({ ok: true, user: result.rows[0] });
  } catch (e) {
    console.error('[auth/verify] error:', e);
    res.status(401).json({ error: 'invalid_token' });
  }
});

// ════════════════════════════════════════════════════════
//  END LAYER 9 — LINE LOGIN
// ════════════════════════════════════════════════════════




// ============================================================
//  ENDPOINT: CHAT WITH "หมอน้อย"
// ============================================================
app.post('/api/chat-hornoi', aiLimiter, async (req, res) => {
  const { messages, system } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'missing_messages', message: 'messages must be a non-empty array' });
  }

  const defaultSystem = `คุณคือ "หมอน้อย" (Dr. Little) ผู้ช่วย AI สำหรับผู้ป่วยไทยในแอป MedTrack
- ตอบเป็นภาษาไทย เข้าใจง่าย อบอุ่น เป็นกันเอง
- ให้ข้อมูลสุขภาพเบื้องต้น แต่เตือนเสมอว่าไม่ทดแทนคำแนะนำจากแพทย์
- ถ้าถามเรื่องวินิจฉัยโรค หรือยาที่ไม่ใช่ยาของผู้ป่วย แนะนำให้ปรึกษาแพทย์/เภสัชกร
- ถ้าเป็นอาการฉุกเฉิน (เจ็บหน้าอก หายใจไม่ออก หมดสติ) แนะนำโทร 1669 ทันที
- ตอบสั้น กระชับ 2-4 ประโยค`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system: [
        {
          type: 'text',
          text: system || defaultSystem,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: messages.slice(-10),
    });

    const reply = msg.content?.[0]?.text || '';
    const cu = msg.usage || {};
    const chCacheRead = cu.cache_read_input_tokens || 0;
    const chCacheCreate = cu.cache_creation_input_tokens || 0;
    const chStatus = chCacheRead > 0 ? 'HIT' : (chCacheCreate > 0 ? 'WRITE' : 'MISS');
    console.log(`[chat-cache] ${chStatus} · read=${chCacheRead} · write=${chCacheCreate} · input=${cu.input_tokens || 0} · output=${cu.output_tokens || 0}`);
    res.json({ ok: true, reply, usage: msg.usage });
  } catch (e) {
    console.error('[chat-hornoi] error:', e.message, e.status || '');
    res.status(e.status || 500).json({ error: 'ai_error', message: e.message });
  }
});

// ============================================================
//  SCHEDULER — LINE PUSH REMINDERS (NEW v1.4.0)
//  Runs every minute via node-cron
// ============================================================

// Helper: get current HH:mm in Bangkok timezone (matches cron timezone)
function getCurrentHHmmBangkok() {
  const now = new Date();
  // Format in Asia/Bangkok using Intl API (no dependency needed)
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return formatter.format(now);  // returns "07:05"
}

// Helper: check if user already got a push at this HH:mm today (duplicate prevention)
async function alreadySentToday(userId, hhmm) {
  const result = await db.query(`
    SELECT id FROM push_logs
    WHERE user_id = $1
      AND status = 'sent'
      AND DATE(sent_at AT TIME ZONE 'Asia/Bangkok') = CURRENT_DATE
      AND TO_CHAR(sent_at AT TIME ZONE 'Asia/Bangkok', 'HH24:MI') = $2
    LIMIT 1
  `, [userId, hhmm]);
  return result.rows.length > 0;
}

// Helper: count push_logs in last 30 days (quota check)
async function getMonthlyPushCount() {
  const result = await db.query(`
    SELECT COUNT(*)::int AS cnt FROM push_logs
    WHERE status = 'sent'
      AND sent_at > NOW() - INTERVAL '30 days'
  `);
  return result.rows[0].cnt;
}

// Main scheduler function — runs every minute
// ── Frequency pattern: is this dose due today? ───────────────
function isDoseDueToday(schedule) {
  const pattern = schedule.frequency_pattern || 'daily';
  if (pattern === 'daily') return true;

  // Bangkok "today" at midnight
  const now = new Date();
  const bkkOffsetMs = 7 * 60 * 60 * 1000;
  const bkkNow = new Date(now.getTime() + bkkOffsetMs);
  const today = new Date(Date.UTC(bkkNow.getUTCFullYear(), bkkNow.getUTCMonth(), bkkNow.getUTCDate()));

  if (pattern === 'weekly') {
    // day_of_week: 0=Sun .. 6=Sat
    if (schedule.day_of_week === null || schedule.day_of_week === undefined) return true;
    return today.getUTCDay() === schedule.day_of_week;
  }

  if (pattern === 'monthly') {
    if (schedule.day_of_month === null || schedule.day_of_month === undefined) return true;
    return today.getUTCDate() === schedule.day_of_month;
  }

  if (pattern === 'alternate' || pattern === 'every_n_days') {
    const interval = pattern === 'alternate' ? 2 : (schedule.frequency_interval || 1);
    if (!schedule.start_date) return true; // no anchor → treat as daily
    const start = new Date(schedule.start_date);
    const startDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    const diffDays = Math.round((today - startDay) / (24 * 60 * 60 * 1000));
    if (diffDays < 0) return false; // before start
    return diffDays % interval === 0;
  }

  return true; // unknown pattern → fail safe (send)
}

async function checkAndSendReminders() {
  if (!lineClient) return;
  
  const hhmm = getCurrentHHmmBangkok();
  
  try {
    // 1. Quota guard
    const monthlyCount = await getMonthlyPushCount();
    const quotaLimit = PUSH_QUOTA_MONTHLY - PUSH_QUOTA_SAFETY_MARGIN;  // 500 - 50 = 450
    if (monthlyCount >= quotaLimit) {
      console.warn(`[scheduler] ⚠️  Quota near limit: ${monthlyCount}/${PUSH_QUOTA_MONTHLY} — skipping this tick`);
      return;
    }
    
    // 2. Query schedules due now
    const scheduleResult = await db.query(`
      SELECT 
        ds.id AS schedule_id, ds.medication_id, ds.user_id,
        ds.meal_anchor, ds.meal_relation, ds.reminder_time,
        ds.tablets_per_dose, ds.ml_per_dose,
        ds.frequency_pattern, ds.frequency_interval,
        ds.day_of_week, ds.day_of_month, ds.start_date,
        m.drug_name, m.drug_name_raw, m.dose_mg, m.dose_unit,
        m.is_high_alert, m.drug_image_url,
        u.name AS user_name, u.line_user_id, u.push_lead_minutes
      FROM dose_schedules ds
      JOIN medications m ON m.id = ds.medication_id
      JOIN users u ON u.id = ds.user_id
      WHERE TO_CHAR(ds.reminder_time, 'HH24:MI') = $1
        AND ds.is_active = TRUE
        AND (ds.end_date IS NULL OR ds.end_date >= CURRENT_DATE)
        AND m.is_active = TRUE
        AND m.deleted_at IS NULL
        AND (m.paused_until IS NULL OR m.paused_until < CURRENT_DATE)
        AND u.line_user_id IS NOT NULL
        AND u.deleted_at IS NULL
    `, [hhmm]);
    
    if (scheduleResult.rows.length === 0) return;  // nothing due, exit quietly
    
    console.log(`[scheduler] tick ${hhmm} — found ${scheduleResult.rows.length} schedules due`);

    // 2b. Filter by frequency_pattern (skip if today is not a dose day)
    const dueToday = scheduleResult.rows.filter(s => isDoseDueToday(s));
    if (dueToday.length === 0) {
      console.log(`[scheduler] tick ${hhmm} — none due today after frequency filter`);
      return;
    }
    
    // 3. Group by user_id
    const byUser = new Map();
    for (const s of dueToday) {
      if (!byUser.has(s.user_id)) byUser.set(s.user_id, []);
      byUser.get(s.user_id).push(s);
    }
    
    // 4. Push per user (1 push per user = save quota)
    for (const [userId, userSchedules] of byUser.entries()) {
      // 4a. Duplicate prevention — check if we pushed for this user at this HH:mm today already
      const already = await alreadySentToday(userId, hhmm);
      if (already) {
        console.log(`[scheduler] user=${userId} already received push at ${hhmm} today — skip`);
        continue;
      }
      
      const firstRow = userSchedules[0];
      const userName = firstRow.user_name || 'คุณ';
      const lineUserId = firstRow.line_user_id;
      const leadMinutes = firstRow.push_lead_minutes || 0;
      
      const messageText = buildReminderText(userName, userSchedules, leadMinutes);
      const scheduleIds = userSchedules.map(s => s.schedule_id);
      
      // 4b. Insert push_log BEFORE sending (pending → sent/failed)
      let logId;
      try {
        const logResult = await db.query(`
          INSERT INTO push_logs (user_id, schedule_ids, scheduled_for, status)
          VALUES ($1, $2, NOW(), 'pending')
          RETURNING id
        `, [userId, scheduleIds]);
        logId = logResult.rows[0].id;
      } catch (e) {
        console.error('[scheduler] failed to insert push_log:', e.message);
        continue;
      }
      
      // 4c. Send push (Flex Message with confirm/skip buttons + create dose_logs)
      try {
        // Phase 1: Create dose_log entries first
        const today = new Date();
        const dateStr = today.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }); // YYYY-MM-DD
        const doseLogIds = [];
        
        for (const s of userSchedules) {
          try {
            const logResult = await db.query(`
              INSERT INTO dose_logs 
                (user_id, medication_id, schedule_id, 
                 scheduled_date, scheduled_time, scheduled_at, 
                 reminder_sent_at, status)
              VALUES ($1, $2, $3, $4, $5, NOW(), NOW(), 'pending')
              ON CONFLICT (medication_id, scheduled_date, scheduled_time) 
              DO UPDATE SET reminder_sent_at = NOW()
              RETURNING id
            `, [userId, s.medication_id, s.schedule_id, dateStr, s.reminder_time]);
            doseLogIds.push(logResult.rows[0].id);
          } catch (e) {
            console.error('[scheduler] failed to insert dose_log:', e.message);
          }
        }
        
        // Build Flex Message with confirm/skip buttons
        const flexMessage = buildReminderFlexMessage(userName, userSchedules, doseLogIds);
        
        await lineClient.pushMessage(lineUserId, flexMessage);
        
        await db.query(`
          UPDATE push_logs SET status = 'sent', sent_at = NOW() WHERE id = $1
        `, [logId]);
        
        console.log(`[scheduler] ✅ pushed (Flex) to user=${userId} (${userName}) schedules=${scheduleIds.length} dose_logs=${doseLogIds.length}`);
      } catch (e) {
        console.error(`[scheduler] ❌ push failed for user=${userId}:`, e.message);
        await db.query(`
          UPDATE push_logs SET status = 'failed', error_message = $2 WHERE id = $1
        `, [logId, (e.message || 'unknown').substring(0, 500)]);
      }
    }
  } catch (e) {
    console.error('[scheduler] tick error:', e.message, e.stack);
  }
}

// Track scheduler handle for graceful shutdown
let schedulerTask = null;

function startScheduler() {
  if (schedulerTask) {
    console.warn('[scheduler] already running — skipping start');
    return;
  }
  
  schedulerTask = cron.schedule('* * * * *', checkAndSendReminders, {
    scheduled: true,
    timezone: 'Asia/Bangkok',
  });
  
  console.log('✅ Scheduler started (every minute, Asia/Bangkok)');
}

function stopScheduler() {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
    console.log('🛑 Scheduler stopped');
  }
}

// ════════════════════════════════════════════════════════
//  PHASE 5: APPOINTMENT REMINDER CRON
//  Runs daily at 09:00 Asia/Bangkok
//  Sends LINE Flex reminders 7, 3, 1 days before appointment
// ════════════════════════════════════════════════════════

let appointmentCronTask = null;

function startAppointmentReminderCron() {
  if (appointmentCronTask) {
    console.warn('[appt-cron] already running — skipping');
    return;
  }
  
  // Run daily at 09:00 Asia/Bangkok
  appointmentCronTask = cron.schedule('0 9 * * *', sendAppointmentReminders, {
    scheduled: true,
    timezone: 'Asia/Bangkok',
  });
  
  console.log('✅ Appointment reminder cron started (daily 09:00 Asia/Bangkok)');
}

async function sendAppointmentReminders() {
  console.log('[appt-cron] running daily check...');
  
  try {
    // Find appointments in 7, 3, or 1 days that haven't been reminded yet
    const result = await db.query(`
      SELECT 
        a.*,
        u.line_user_id,
        u.name AS user_name,
        (a.appointment_date - CURRENT_DATE) AS days_until
      FROM appointments a
      JOIN users u ON a.user_id = u.id
      WHERE a.deleted_at IS NULL
        AND u.line_user_id IS NOT NULL
        AND a.appointment_date > CURRENT_DATE
        AND (
          (a.appointment_date - CURRENT_DATE = 7 AND a.reminder_7d_sent = FALSE) OR
          (a.appointment_date - CURRENT_DATE = 3 AND a.reminder_3d_sent = FALSE) OR
          (a.appointment_date - CURRENT_DATE = 1 AND a.reminder_1d_sent = FALSE)
        )
    `);
    
    console.log(`[appt-cron] found ${result.rows.length} appointments to remind`);
    
    let sentCount = 0;
    for (const appt of result.rows) {
      try {
        const daysUntil = appt.days_until;
        const flex = buildAppointmentReminderFlex(appt, daysUntil);
        
        await lineClient.pushMessage(appt.line_user_id, flex);
        
        // Mark reminder as sent
        const flagField = daysUntil === 7 ? 'reminder_7d_sent' :
                          daysUntil === 3 ? 'reminder_3d_sent' :
                          'reminder_1d_sent';
        
        await db.query(
          `UPDATE appointments SET ${flagField} = TRUE WHERE id = $1`,
          [appt.id]
        );
        
        sentCount++;
        console.log(`[appt-cron] ✅ sent ${daysUntil}d reminder for appointment ${appt.id}`);
      } catch (e) {
        console.error(`[appt-cron] failed to send for ${appt.id}:`, e.message);
      }
    }
    
    if (sentCount > 0) {
      console.log(`[appt-cron] sent ${sentCount} reminders`);
    }
  } catch (e) {
    console.error('[appt-cron] error:', e.message);
  }
}

function buildAppointmentReminderFlex(appt, daysUntil) {
  const userName = appt.user_name || '';
  const firstName = userName.trim().split(/\s+/)[0] || userName;
  
  const daysText = daysUntil === 7 ? 'อีก 7 วัน' :
                   daysUntil === 3 ? 'อีก 3 วัน' :
                   'พรุ่งนี้';
  
  const urgencyColor = daysUntil === 1 ? '#dc2626' :
                       daysUntil === 3 ? '#f59e0b' :
                       '#0a9c7a';
  
  // Format Thai date (พ.ศ.)
  const date = new Date(appt.appointment_date);
  const thaiYear = date.getFullYear() + 543;
  const months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const dateStr = `${date.getDate()} ${months[date.getMonth()]} ${thaiYear}`;
  
  return {
    type: 'flex',
    altText: `🏥 เตือนนัดแพทย์ ${daysText} - ${appt.hospital_name || 'รพ.'}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: '🏥 เตือนนัดแพทย์',
            color: '#ffffff',
            weight: 'bold',
            size: 'md',
          },
          {
            type: 'text',
            text: daysText,
            color: '#ffffff',
            size: 'xl',
            weight: 'bold',
            margin: 'sm',
          },
        ],
        backgroundColor: urgencyColor,
        paddingAll: '16px',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: `สวัสดีครับ คุณ${firstName} 🩺`,
            weight: 'bold',
            size: 'sm',
            color: '#475569',
          },
          {
            type: 'separator',
            margin: 'md',
          },
          ...(appt.hospital_name ? [{
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '🏥', size: 'sm', flex: 0 },
              { type: 'text', text: appt.hospital_name, weight: 'bold', size: 'md', flex: 1, margin: 'sm', wrap: true },
            ],
          }] : []),
          ...(appt.doctor_name ? [{
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '👨‍⚕️', size: 'sm', flex: 0 },
              { type: 'text', text: appt.doctor_name, size: 'sm', flex: 1, margin: 'sm', wrap: true },
            ],
          }] : []),
          ...(appt.department ? [{
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '📋', size: 'sm', flex: 0 },
              { type: 'text', text: appt.department, size: 'sm', flex: 1, margin: 'sm', wrap: true },
            ],
          }] : []),
          {
            type: 'box',
            layout: 'baseline',
            margin: 'md',
            contents: [
              { type: 'text', text: '📅', size: 'sm', flex: 0 },
              { type: 'text', text: dateStr, weight: 'bold', size: 'md', flex: 1, margin: 'sm', color: urgencyColor },
            ],
          },
          ...(appt.appointment_time ? [{
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '🕐', size: 'sm', flex: 0 },
              { type: 'text', text: appt.appointment_time, size: 'sm', flex: 1, margin: 'sm' },
            ],
          }] : []),
          ...(appt.building ? [{
            type: 'box',
            layout: 'baseline',
            contents: [
              { type: 'text', text: '📍', size: 'sm', flex: 0 },
              { type: 'text', text: appt.building, size: 'xs', flex: 1, margin: 'sm', wrap: true, color: '#64748b' },
            ],
          }] : []),
          ...(appt.instructions && appt.instructions.length > 0 ? [
            { type: 'separator', margin: 'md' },
            { type: 'text', text: '⚠️ คำแนะนำ:', size: 'xs', weight: 'bold', color: '#92400e', margin: 'sm' },
            ...appt.instructions.slice(0, 3).map(ins => ({
              type: 'text',
              text: '• ' + ins,
              size: 'xs',
              wrap: true,
              color: '#92400e',
              margin: 'xs',
            })),
          ] : []),
        ],
        paddingAll: '16px',
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: 'ห้ามลืมไปนะครับ! 💪',
            size: 'xs',
            align: 'center',
            color: '#64748b',
          },
        ],
        paddingAll: '12px',
      },
    },
  };
}

// ════════════════════════════════════════════════════════
//  END PHASE 5 APPOINTMENT REMINDER
// ════════════════════════════════════════════════════════


// ─── Manual trigger endpoint for testing (dev only) ───
// Protected by a secret header to avoid abuse
app.post('/api/scheduler/trigger', async (req, res) => {
  const secret = req.headers['x-scheduler-secret'];
  if (!process.env.SCHEDULER_TRIGGER_SECRET || secret !== process.env.SCHEDULER_TRIGGER_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  console.log('[scheduler] manual trigger requested');
  try {
    await checkAndSendReminders();
    res.json({ ok: true, triggered_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: 'trigger_failed', message: e.message });
  }
});
// ════════════════════════════════════════════════════
//  OCR TEST SYSTEM ENDPOINTS (Session 12 — May 2026)
// ════════════════════════════════════════════════════

// POST /api/ocr-test/batches — Create new batch
app.post('/api/ocr-test/batches', userLimiter, async (req, res) => {
  const { batch_name, patient_label, created_by, hospital_name, department, note } = req.body || {};
  if (!batch_name || typeof batch_name !== 'string' || batch_name.trim().length < 1) {
    return res.status(400).json({ error: 'invalid_batch_name' });
  }
  try {
    const result = await db.query(`
      INSERT INTO ocr_test_batches
        (batch_name, patient_label, created_by, hospital_name, department, note)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [batch_name.trim(), patient_label || null, created_by || null, hospital_name || null, department || null, note || null]);
    console.log(`[ocr-test] batch created id=${result.rows[0].id} name="${batch_name}"`);
    res.json({ ok: true, batch: result.rows[0] });
  } catch (e) {
    console.error('[ocr-test/batches POST]', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// GET /api/ocr-test/batches — List batches with stats
app.get('/api/ocr-test/batches', readLimiter, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT b.*,
        (SELECT COUNT(*) FROM ocr_test_runs WHERE batch_id = b.id AND deleted_at IS NULL) AS run_count,
        (SELECT COUNT(*) FROM ocr_test_runs WHERE batch_id = b.id AND status = 'success' AND deleted_at IS NULL) AS success_count,
        (SELECT AVG(ai_response_ms) FROM ocr_test_runs WHERE batch_id = b.id AND status = 'success' AND deleted_at IS NULL) AS avg_response_ms,
        (SELECT AVG(ai_confidence) FROM ocr_test_runs WHERE batch_id = b.id AND status = 'success' AND deleted_at IS NULL) AS avg_confidence
      FROM ocr_test_batches b
      WHERE b.deleted_at IS NULL
      ORDER BY b.created_at DESC
      LIMIT 100
    `);
    res.json({ ok: true, batches: result.rows });
  } catch (e) {
    console.error('[ocr-test/batches GET]', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// POST /api/ocr-test/runs — Add image to batch
app.post('/api/ocr-test/runs', userLimiter, async (req, res) => {
  const { batch_id, image_base64, media_type, device_info, sequence_num } = req.body || {};
  if (!batch_id || !image_base64) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const imageSizeKb = Math.round((image_base64.length * 3 / 4) / 1024);
  const di = device_info || {};
  try {
    const result = await db.query(`
      INSERT INTO ocr_test_runs (
        batch_id, sequence_num, image_base64, image_size_kb, image_mime_type,
        device_platform, device_model, device_browser, device_screen, device_user_agent, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
      RETURNING id, batch_id, sequence_num, status, image_size_kb, created_at
    `, [
      batch_id, sequence_num || 1, image_base64, imageSizeKb, media_type || 'image/jpeg',
      di.platform || null, di.model || null, di.browser || null, di.screen || null, di.userAgent || null,
    ]);
    res.json({ ok: true, run: result.rows[0] });
  } catch (e) {
    console.error('[ocr-test/runs POST]', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// POST /api/ocr-test/scan-direct — Scan image → AI ทันที + บันทึก result
// ═══════════════════════════════════════════════════════════
// Hybrid approach: ส่งภาพให้ AI ตรง (เหมือน /api/scan-medicine ทุกประการ)
// แล้วบันทึก result ลง DB เพื่อให้ batch UI แสดง history ได้
//
// ข้อดี:
//  • ไม่มี DB round-trip → ภาพไปถึง AI เป็น base64 เดียวกับ MedTrack Scan
//  • Test environment = Production environment
//  • Image ไม่จำเป็นต้องเก็บใน DB (เลือกได้ผ่าน save_image flag)
app.post('/api/ocr-test/scan-direct', userLimiter, async (req, res) => {
  const { batch_id, image_base64, media_type, device_info, sequence_num, save_image } = req.body || {};
  if (!batch_id || !image_base64) {
    return res.status(400).json({ error: 'missing_fields', message: 'batch_id and image_base64 required' });
  }
  const mediaType = media_type || 'image/jpeg';
  const imageSizeKb = Math.round((image_base64.length * 3 / 4) / 1024);
  const di = device_info || {};

  // 1) สร้าง run record (status=analyzing) — เก็บ image เฉพาะถ้า save_image=true
  let runId;
  try {
    const insertResult = await db.query(`
      INSERT INTO ocr_test_runs (
        batch_id, sequence_num, image_base64, image_size_kb, image_mime_type,
        device_platform, device_model, device_browser, device_screen, device_user_agent, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'analyzing')
      RETURNING id
    `, [
      batch_id, sequence_num || 1,
      save_image ? image_base64 : null,
      imageSizeKb, mediaType,
      di.platform || null, di.model || null, di.browser || null, di.screen || null, di.userAgent || null,
    ]);
    runId = insertResult.rows[0].id;
  } catch (e) {
    console.error('[scan-direct] insert error:', e.message);
    return res.status(500).json({ error: 'db_error', message: e.message });
  }

  // 2) ส่ง AI ตรง — เหมือน /api/scan-medicine ทุกประการ
  const startTime = Date.now();
  let aiData;
  try {
    const result = await callClaudeVisionJSON({
      imageBase64: image_base64,
      mediaType,
      prompt: SCAN_MEDICINE_PROMPT_V4,
      maxTokens: 2000,
    });
    aiData = applyAllPostProcessors(result.parsed);
  } catch (aiErr) {
    const elapsed = Date.now() - startTime;
    await db.query(`
      UPDATE ocr_test_runs SET status = 'failed', error_message = $2, ai_response_ms = $3, analyzed_at = NOW()
      WHERE id = $1
    `, [runId, aiErr.message.slice(0, 500), elapsed]);
    if (aiErr.message === 'ai_response_not_json') {
      return res.status(502).json({ error: 'ai_response_not_json', message: 'AI did not return valid JSON', raw: aiErr.rawText, run_id: runId });
    }
    return res.status(502).json({ error: 'ai_error', message: aiErr.message, run_id: runId });
  }

  // 3) บันทึก result (โครงสร้างเหมือน /api/ocr-test/runs/:id/analyze)
  const elapsed = Date.now() - startTime;
  const d0 = (Array.isArray(aiData.doses) && aiData.doses.length) ? aiData.doses[0] : {};
  const derivedFreqPerDay = (aiData.doses && aiData.doses.length)
    ? (d0.frequency_pattern === 'daily' || !d0.frequency_pattern ? aiData.doses.length : null)
    : null;
  const derivedMealAnchor = d0.meal_anchor || null;
  const derivedMealRelation = d0.meal_relation || null;

  const missingFields = [];
  if (!aiData.drug_name) missingFields.push('drug_name');
  if (!aiData.drug_name_en) missingFields.push('drug_name_en');
  if (aiData.dose_mg === null || aiData.dose_mg === undefined || aiData.dose_mg === '') missingFields.push('dose_mg');
  if (!aiData.doses || aiData.doses.length === 0) {
    missingFields.push('doses');
  } else {
    if (!derivedMealAnchor) missingFields.push('meal_anchor');
    if (d0.tablets_per_dose === null || d0.tablets_per_dose === undefined) {
      if (d0.ml_per_dose === null || d0.ml_per_dose === undefined) missingFields.push('dose_amount');
    }
  }

  try {
    await db.query(`
      UPDATE ocr_test_runs SET
        status = 'success', ai_raw_response = $2, ai_confidence = $3, ai_response_ms = $4,
        ai_drug_name = $5, ai_drug_name_en = $6, ai_dose_mg = $7, ai_dose_unit = $8,
        ai_timing_type = $9, ai_meal_anchor = $10, ai_meal_relation = $11,
        ai_frequency_per_day = $12, ai_hospital_name = $13, missing_fields = $14,
        analyzed_at = NOW()
      WHERE id = $1
    `, [
      runId, JSON.stringify(aiData), aiData.confidence || null, elapsed,
      aiData.drug_name || null, aiData.drug_name_en || null, aiData.dose_mg || null, aiData.dose_unit || null,
      d0.meal_anchor || null, derivedMealAnchor, derivedMealRelation,
      derivedFreqPerDay, aiData.hospital_name || null, missingFields,
    ]);
  } catch (e) {
    console.error('[scan-direct] update error:', e.message);
    // Result already done; return anyway
  }

  res.json({ ok: true, run_id: runId, ai_response: aiData, ai_response_ms: elapsed, missing_fields: missingFields });
});

// POST /api/ocr-test/runs/:id/analyze — Run AI OCR (legacy 2-step flow)
app.post('/api/ocr-test/runs/:id/analyze', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    const runResult = await db.query(`
      SELECT id, image_base64, image_mime_type, status
      FROM ocr_test_runs WHERE id = $1 AND deleted_at IS NULL
    `, [id]);
    if (runResult.rows.length === 0) return res.status(404).json({ error: 'run_not_found' });
    const run = runResult.rows[0];
    if (run.status === 'success') return res.json({ ok: true, already_analyzed: true, run_id: id });

    await db.query(`UPDATE ocr_test_runs SET status = 'analyzing' WHERE id = $1`, [id]);

    const prompt = SCAN_MEDICINE_PROMPT_V4;

    const startTime = Date.now();
    let aiData;
    try {
      const result = await callClaudeVisionJSON({
        imageBase64: run.image_base64,
        mediaType: run.image_mime_type || 'image/jpeg',
        prompt: prompt,
        maxTokens: 2000,
      });
      aiData = applyAllPostProcessors(result.parsed);
    } catch (aiErr) {
      const elapsed = Date.now() - startTime;
      await db.query(`
        UPDATE ocr_test_runs SET status = 'failed', error_message = $2, ai_response_ms = $3, analyzed_at = NOW()
        WHERE id = $1
      `, [id, aiErr.message.slice(0, 500), elapsed]);
      return res.status(502).json({ error: 'ai_error', message: aiErr.message });
    }

    const elapsed = Date.now() - startTime;

    // AI ตอบเป็น doses[] — ดึงค่ามื้อแรกมาเก็บใน flat columns (สำหรับ filter/analytics)
    const d0 = (Array.isArray(aiData.doses) && aiData.doses.length) ? aiData.doses[0] : {};
    const derivedFreqPerDay = (aiData.doses && aiData.doses.length)
      ? (d0.frequency_pattern === 'daily' || !d0.frequency_pattern ? aiData.doses.length : null)
      : null;
    const derivedMealAnchor = d0.meal_anchor || null;
    const derivedMealRelation = d0.meal_relation || null;

    const missingFields = [];
    // เช็คความครบของข้อมูลสำคัญ — ดึงจาก doses[] ไม่ใช่ top-level
    if (!aiData.drug_name) missingFields.push('drug_name');
    if (!aiData.drug_name_en) missingFields.push('drug_name_en');
    if (aiData.dose_mg === null || aiData.dose_mg === undefined || aiData.dose_mg === '') missingFields.push('dose_mg');
    if (!aiData.doses || aiData.doses.length === 0) {
      missingFields.push('doses');
    } else {
      if (!derivedMealAnchor) missingFields.push('meal_anchor');
      if (d0.tablets_per_dose === null || d0.tablets_per_dose === undefined) {
        // ยาน้ำใช้ ml แทน เม็ด → ไม่นับ missing ถ้ามี ml
        if (d0.ml_per_dose === null || d0.ml_per_dose === undefined) missingFields.push('dose_amount');
      }
    }

    await db.query(`
      UPDATE ocr_test_runs SET
        status = 'success', ai_raw_response = $2, ai_confidence = $3, ai_response_ms = $4,
        ai_drug_name = $5, ai_drug_name_en = $6, ai_dose_mg = $7, ai_dose_unit = $8,
        ai_timing_type = $9, ai_meal_anchor = $10, ai_meal_relation = $11,
        ai_frequency_per_day = $12, ai_hospital_name = $13, missing_fields = $14,
        analyzed_at = NOW()
      WHERE id = $1
    `, [
      id, JSON.stringify(aiData), aiData.confidence || null, elapsed,
      aiData.drug_name || null, aiData.drug_name_en || null, aiData.dose_mg || null, aiData.dose_unit || null,
      d0.meal_anchor || null, derivedMealAnchor, derivedMealRelation,
      derivedFreqPerDay, aiData.hospital_name || null, missingFields,
    ]);

    res.json({ ok: true, run_id: id, response_ms: elapsed, ai_data: aiData, missing_fields: missingFields });
  } catch (e) {
    console.error('[ocr-test/analyze]', e.message);
    res.status(500).json({ error: 'server_error', message: e.message });
  }
});

// GET /api/ocr-test/batches/:id/runs — List runs in batch
app.get('/api/ocr-test/batches/:id/runs', readLimiter, async (req, res) => {
  const batchId = parseInt(req.params.id);
  if (!batchId) return res.status(400).json({ error: 'invalid_id' });
  try {
    const result = await db.query(`
      SELECT id, batch_id, sequence_num, image_size_kb, image_width, image_height, image_mime_type,
        device_platform, device_model, device_browser,
        ai_raw_response, ai_confidence, ai_response_ms,
        ai_drug_name, ai_drug_name_en, ai_dose_mg, ai_dose_unit,
        ai_timing_type, ai_meal_anchor, ai_meal_relation,
        ai_frequency_per_day, ai_hospital_name,
        missing_fields, status, error_message,
        pharmacist_decision, pharmacist_note,
        created_at, analyzed_at
      FROM ocr_test_runs
      WHERE batch_id = $1 AND deleted_at IS NULL
      ORDER BY sequence_num ASC, id ASC
    `, [batchId]);
    res.json({ ok: true, runs: result.rows });
  } catch (e) {
    console.error('[ocr-test/runs GET]', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// GET /api/ocr-test/runs/:id/image — Get image for a run
app.get('/api/ocr-test/runs/:id/image', readLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    const result = await db.query(`
      SELECT image_base64, image_mime_type FROM ocr_test_runs WHERE id = $1 AND deleted_at IS NULL
    `, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, image_base64: result.rows[0].image_base64, media_type: result.rows[0].image_mime_type });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// DELETE /api/ocr-test/runs/:id — Soft delete run
app.delete('/api/ocr-test/runs/:id', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    await db.query(`UPDATE ocr_test_runs SET deleted_at = NOW() WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'db_error', message: e.message }); }
});

// DELETE /api/ocr-test/batches/:id — Soft delete batch
app.delete('/api/ocr-test/batches/:id', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    await db.query(`UPDATE ocr_test_batches SET deleted_at = NOW() WHERE id = $1`, [id]);
    await db.query(`UPDATE ocr_test_runs SET deleted_at = NOW() WHERE batch_id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'db_error', message: e.message }); }
});

// GET /api/ocr-test/stats — Overall statistics
app.get('/api/ocr-test/stats', userLimiter, async (req, res) => {
  try {
    const fieldStatsResult = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'success') AS total_success,
        COUNT(*) FILTER (WHERE 'drug_name' = ANY(missing_fields) AND status = 'success') AS missing_drug_name,
        COUNT(*) FILTER (WHERE 'drug_name_en' = ANY(missing_fields) AND status = 'success') AS missing_drug_name_en,
        COUNT(*) FILTER (WHERE 'dose_mg' = ANY(missing_fields) AND status = 'success') AS missing_dose_mg,
        COUNT(*) FILTER (WHERE 'frequency_per_day' = ANY(missing_fields) AND status = 'success') AS missing_frequency,
        COUNT(*) FILTER (WHERE 'timing_type' = ANY(missing_fields) AND status = 'success') AS missing_timing_type,
        COUNT(*) FILTER (WHERE 'meal_anchor' = ANY(missing_fields) AND status = 'success') AS missing_meal_anchor,
        AVG(ai_response_ms) AS avg_response_ms,
        MIN(ai_response_ms) AS min_response_ms,
        MAX(ai_response_ms) AS max_response_ms,
        AVG(ai_confidence) AS avg_confidence
      FROM ocr_test_runs WHERE deleted_at IS NULL AND status = 'success'
    `);
    const deviceStatsResult = await db.query(`
      SELECT device_platform, device_model, device_browser,
        COUNT(*) AS run_count, AVG(ai_response_ms) AS avg_response_ms,
        AVG(ai_confidence) AS avg_confidence, AVG(image_size_kb) AS avg_image_kb
      FROM ocr_test_runs WHERE deleted_at IS NULL AND status = 'success'
      GROUP BY device_platform, device_model, device_browser
      ORDER BY run_count DESC
    `);
    res.json({ ok: true, field_stats: fieldStatsResult.rows[0], device_stats: deviceStatsResult.rows });
  } catch (e) {
    console.error('[ocr-test/stats]', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});
// ════════════════════════════════════════════════════
//  APPOINTMENT OCR TEST SYSTEM (เพิ่ม มิ.ย. 2569)
//  ขนานกับ OCR TEST SYSTEM ของซองยา แต่ใช้ /api/scan-appointment prompt
//  วิธีติดตั้ง: paste บล็อกนี้ใน server.js ก่อน "END OCR TEST SYSTEM"
//  (หรือก่อน 404 handler ก็ได้)
// ════════════════════════════════════════════════════

// POST /api/appt-test/batches — สร้าง batch ใหม่
app.post('/api/appt-test/batches', userLimiter, async (req, res) => {
  const { batch_name, patient_label, created_by, hospital_name, department, note } = req.body || {};
  if (!batch_name || typeof batch_name !== 'string' || batch_name.trim().length < 1) {
    return res.status(400).json({ error: 'invalid_batch_name' });
  }
  try {
    const result = await db.query(`
      INSERT INTO appointment_test_batches
        (batch_name, patient_label, created_by, hospital_name, department, note)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [batch_name.trim(), patient_label || null, created_by || null, hospital_name || null, department || null, note || null]);
    console.log(`[appt-test] batch created id=${result.rows[0].id}`);
    res.json({ ok: true, batch: result.rows[0] });
  } catch (e) {
    console.error('[appt-test/batches POST]', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// GET /api/appt-test/batches — list + stats
app.get('/api/appt-test/batches', userLimiter, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT b.*,
        (SELECT COUNT(*) FROM appointment_test_runs WHERE batch_id = b.id AND deleted_at IS NULL) AS run_count,
        (SELECT COUNT(*) FROM appointment_test_runs WHERE batch_id = b.id AND status = 'success' AND deleted_at IS NULL) AS success_count,
        (SELECT AVG(ai_response_ms) FROM appointment_test_runs WHERE batch_id = b.id AND status = 'success' AND deleted_at IS NULL) AS avg_response_ms,
        (SELECT AVG(ai_confidence) FROM appointment_test_runs WHERE batch_id = b.id AND status = 'success' AND deleted_at IS NULL) AS avg_confidence
      FROM appointment_test_batches b
      WHERE b.deleted_at IS NULL
      ORDER BY b.created_at DESC
      LIMIT 100
    `);
    res.json({ ok: true, batches: result.rows });
  } catch (e) {
    console.error('[appt-test/batches GET]', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// POST /api/appt-test/runs — เพิ่มภาพเข้า batch
app.post('/api/appt-test/runs', userLimiter, async (req, res) => {
  const { batch_id, image_base64, media_type, device_info, sequence_num } = req.body || {};
  if (!batch_id || !image_base64) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const imageSizeKb = Math.round((image_base64.length * 3 / 4) / 1024);
  const di = device_info || {};
  try {
    const result = await db.query(`
      INSERT INTO appointment_test_runs (
        batch_id, sequence_num, image_base64, image_size_kb, image_mime_type,
        device_platform, device_model, device_browser, device_screen, device_user_agent, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
      RETURNING id, batch_id, sequence_num, status, image_size_kb, created_at
    `, [
      batch_id, sequence_num || 1, image_base64, imageSizeKb, media_type || 'image/jpeg',
      di.platform || null, di.model || null, di.browser || null, di.screen || null, di.userAgent || null,
    ]);
    res.json({ ok: true, run: result.rows[0] });
  } catch (e) {
    console.error('[appt-test/runs POST]', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// POST /api/appt-test/runs/:id/analyze — รัน AI ด้วย prompt ใบนัด
app.post('/api/appt-test/runs/:id/analyze', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    const runResult = await db.query(`
      SELECT id, image_base64, image_mime_type, status
      FROM appointment_test_runs WHERE id = $1 AND deleted_at IS NULL
    `, [id]);
    if (runResult.rows.length === 0) return res.status(404).json({ error: 'run_not_found' });
    const run = runResult.rows[0];
    if (run.status === 'success') return res.json({ ok: true, already_analyzed: true, run_id: id });

    await db.query(`UPDATE appointment_test_runs SET status = 'analyzing' WHERE id = $1`, [id]);

    // prompt ใบนัด (ย่อจาก /api/scan-appointment v2 — เน้น 9 ฟิลด์หลัก)
    const prompt = `คุณเป็น AI ผู้เชี่ยวชาญอ่านใบนัดแพทย์ของโรงพยาบาลในไทย
อ่านข้อมูลจากภาพจริงเท่านั้น ห้ามเดา ถ้า field ใด blackout/อ่านไม่ได้ ให้ใส่ ""

หา label แล้วอ่าน value ที่ติดกัน:
- "ชื่อแพทย์"/"แพทย์"/"ผู้ตรวจ" → doctor_name (ขึ้นต้น นพ./พญ./ศ.นพ./Dr.)
  ⚠️ ห้ามเอา "ผู้ออกบัตรนัด"/"ผู้บันทึก"/ชื่ออังกฤษล้วน มาเป็น doctor_name
- "ชื่อผู้ป่วย"/"ผู้ป่วย" → patient_name (มีคำนำหน้า นาย/นาง/น.ส.)
- "คลินิก"/"แผนก" → department
- hospital_name: อ่านตัวอักษรจริง ห้าม auto-correct
- "HN"/"เลขผู้ป่วย" → hn (6-8 หลัก ระวัง 0/6/8, 1/7; ไม่ใช่ "เลขที่นัด")
- date_iso: วันที่ต้องมาพบแพทย์ครั้งถัดไป (ไม่ใช่วันออกใบนัด) แปลง พ.ศ.→ค.ศ. (ลบ 543) เช่น 17/06/2569 → "2026-06-17"
- time_str: เวลานัด เช่น "13:00-16:00"
- building: อาคาร/ชั้น/ห้อง

ตอบกลับเป็น JSON เท่านั้น ห้ามมี text นอก JSON:
{
  "doctor_name": "",
  "department": "",
  "hospital_name": "",
  "building": "",
  "date_str": "",
  "date_iso": "YYYY-MM-DD",
  "time_str": "",
  "hn": "",
  "patient_name": "",
  "instructions": [],
  "note": "",
  "confidence": 0.0
}`;

    const startTime = Date.now();
    let aiData;
    try {
      const result = await callClaudeVisionJSON({
        imageBase64: run.image_base64,
        mediaType: run.image_mime_type || 'image/jpeg',
        prompt: prompt,
        maxTokens: 900,
      });
      aiData = result.parsed;
    } catch (aiErr) {
      const elapsed = Date.now() - startTime;
      await db.query(`
        UPDATE appointment_test_runs SET status = 'failed', error_message = $2, ai_response_ms = $3, analyzed_at = NOW()
        WHERE id = $1
      `, [id, aiErr.message.slice(0, 500), elapsed]);
      return res.status(502).json({ error: 'ai_error', message: aiErr.message });
    }

    const elapsed = Date.now() - startTime;

    // ตรวจ field สำคัญที่หาย
    const missingFields = [];
    const importantFields = ['doctor_name', 'hospital_name', 'date_iso', 'hn', 'patient_name'];
    importantFields.forEach(f => {
      const v = aiData[f];
      if (v === null || v === undefined || v === '' || v === 'null') missingFields.push(f);
    });

    // date_iso ต้อง valid ก่อน INSERT (กัน error ถ้า AI ส่ง "YYYY-MM-DD" หรือ "")
    const dateIso = /^\d{4}-\d{2}-\d{2}$/.test(aiData.date_iso) ? aiData.date_iso : null;

    await db.query(`
      UPDATE appointment_test_runs SET
        status = 'success', ai_raw_response = $2, ai_confidence = $3, ai_response_ms = $4,
        ai_doctor_name = $5, ai_department = $6, ai_hospital_name = $7, ai_building = $8,
        ai_date_iso = $9, ai_time_str = $10, ai_hn = $11, ai_patient_name = $12,
        missing_fields = $13, analyzed_at = NOW()
      WHERE id = $1
    `, [
      id, JSON.stringify(aiData), aiData.confidence || null, elapsed,
      aiData.doctor_name || null, aiData.department || null, aiData.hospital_name || null, aiData.building || null,
      dateIso, aiData.time_str || null, aiData.hn || null, aiData.patient_name || null,
      missingFields,
    ]);

    res.json({ ok: true, run_id: id, response_ms: elapsed, ai_data: aiData, missing_fields: missingFields });
  } catch (e) {
    console.error('[appt-test/analyze]', e.message);
    res.status(500).json({ error: 'server_error', message: e.message });
  }
});

// GET /api/appt-test/batches/:id/runs — list runs ใน batch
app.get('/api/appt-test/batches/:id/runs', userLimiter, async (req, res) => {
  const batchId = parseInt(req.params.id);
  if (!batchId) return res.status(400).json({ error: 'invalid_id' });
  try {
    const result = await db.query(`
      SELECT id, batch_id, sequence_num, image_size_kb, image_mime_type,
        device_platform, device_model, device_browser,
        ai_raw_response, ai_confidence, ai_response_ms,
        ai_doctor_name, ai_department, ai_hospital_name, ai_building,
        ai_date_iso, ai_time_str, ai_hn, ai_patient_name,
        missing_fields, status, error_message,
        pharmacist_decision, pharmacist_note,
        created_at, analyzed_at
      FROM appointment_test_runs
      WHERE batch_id = $1 AND deleted_at IS NULL
      ORDER BY sequence_num ASC, id ASC
    `, [batchId]);
    res.json({ ok: true, runs: result.rows });
  } catch (e) {
    console.error('[appt-test/runs GET]', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// GET /api/appt-test/runs/:id/image — ดึงภาพของ run
app.get('/api/appt-test/runs/:id/image', readLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    const result = await db.query(`
      SELECT image_base64, image_mime_type FROM appointment_test_runs WHERE id = $1 AND deleted_at IS NULL
    `, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, image_base64: result.rows[0].image_base64, media_type: result.rows[0].image_mime_type });
  } catch (e) {
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// DELETE /api/appt-test/runs/:id
app.delete('/api/appt-test/runs/:id', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    await db.query(`UPDATE appointment_test_runs SET deleted_at = NOW() WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'db_error', message: e.message }); }
});

// DELETE /api/appt-test/batches/:id
app.delete('/api/appt-test/batches/:id', userLimiter, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'invalid_id' });
  try {
    await db.query(`UPDATE appointment_test_batches SET deleted_at = NOW() WHERE id = $1`, [id]);
    await db.query(`UPDATE appointment_test_runs SET deleted_at = NOW() WHERE batch_id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'db_error', message: e.message }); }
});

// GET /api/appt-test/stats — สถิติรวมของใบนัด
app.get('/api/appt-test/stats', userLimiter, async (req, res) => {
  try {
    const fieldStatsResult = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'success') AS total_success,
        COUNT(*) FILTER (WHERE 'doctor_name' = ANY(missing_fields) AND status = 'success') AS missing_doctor_name,
        COUNT(*) FILTER (WHERE 'hospital_name' = ANY(missing_fields) AND status = 'success') AS missing_hospital_name,
        COUNT(*) FILTER (WHERE 'date_iso' = ANY(missing_fields) AND status = 'success') AS missing_date_iso,
        COUNT(*) FILTER (WHERE 'hn' = ANY(missing_fields) AND status = 'success') AS missing_hn,
        COUNT(*) FILTER (WHERE 'patient_name' = ANY(missing_fields) AND status = 'success') AS missing_patient_name,
        AVG(ai_response_ms) AS avg_response_ms,
        MIN(ai_response_ms) AS min_response_ms,
        MAX(ai_response_ms) AS max_response_ms,
        AVG(ai_confidence) AS avg_confidence
      FROM appointment_test_runs WHERE deleted_at IS NULL AND status = 'success'
    `);
    res.json({ ok: true, field_stats: fieldStatsResult.rows[0] });
  } catch (e) {
    console.error('[appt-test/stats]', e.message);
    res.status(500).json({ error: 'db_error', message: e.message });
  }
});

// ════════════════════════════════════════════════════
//  END APPOINTMENT OCR TEST SYSTEM
// ════════════════════════════════════════════════════

// ════════════════════════════════════════════════════
//  END OCR TEST SYSTEM
// ════════════════════════════════════════════════════
// ============================================================
//  404 + Error handlers
// ============================================================
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Endpoint not found' });
});

app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'internal', message: err.message || 'Internal server error' });
});

// ============================================================
//  START SERVER
// ============================================================
const server = app.listen(PORT, () => {
  console.log(`✅ MedTrack backend v1.9.2 listening on port ${PORT}`);
  console.log(`   Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`   Scheduler: ${SCHEDULER_ENABLED && lineClient ? 'enabled' : 'disabled'}`);
});

// ── Server timeout config — กัน 502 ตอน AI OCR ตอบช้า ──
// AI scan ใช้เวลา ~20-40s (ภาพใหญ่ + multi-dose) → ต้องรอนานพอ
// ค่า default ของ Node = 0 (ไม่ timeout) แต่ headersTimeout/keepAliveTimeout
// ต้องตั้งให้ยาวกว่างานจริง ไม่งั้น socket ปิดก่อน → 502
server.requestTimeout = 120000;      // 120s ต่อ request (เผื่อ AI ช้าสุด)
server.headersTimeout = 125000;      // ต้อง > requestTimeout เล็กน้อย
server.keepAliveTimeout = 120000;    // กัน connection ปิดก่อนตอบเสร็จ
server.timeout = 120000;             // socket timeout

// ============================================================
//  GRACEFUL SHUTDOWN (SIGTERM handler for Railway deploy)
// ============================================================
function gracefulShutdown(signal) {
  console.log(`\n⏸️  ${signal} received — shutting down gracefully...`);
  
  stopScheduler();
  
  server.close(async () => {
    console.log('🛑 HTTP server closed');
    try {
      await db.end();
      console.log('🛑 DB pool closed');
    } catch (e) {
      console.error('DB pool close error:', e.message);
    }
    process.exit(0);
  });
  
  // Force exit after 10s if anything hangs
  setTimeout(() => {
    console.error('⚠️  Forced exit after 10s timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
