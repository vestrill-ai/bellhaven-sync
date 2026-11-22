# Writeup

**Matching approach.** I didn't trust the website directory on its own. The homepage says 35 communities but the
directory only lists 34. Bellhaven Meadows of Findlay is only linked from the homepage, and the pager never ends. So
the scraper crawls the site's own links and collects every community page it finds.

Before comparing anything I clean up both sides: street suffixes and directions (Avenue = Ave, Northwest = NW), ZIPs,
punctuation, and common name differences like Centre vs Center or Rehab vs Rehabilitation. A community only links to
a CRM account on a strong signal: the same address, the same name in the same city, or the website's administrator
being a contact on the account. A similar name alone never links anything. That kept the look-alikes apart: Amberly
Manor in Colorado, Carlisle PA vs New Carlisle OH, and Union Square Senior Living, which is in the same city but at a
different address with a different administrator.

When more than one account matches the same community, the extras are marked as duplicates of the best copy. Accounts
under the wrong parent go through the billing SOP: if they have revenue and open AR, the old account stays as it is and
gets linked to a new Bellhaven account. If not, I move the existing account. Bellhaven accounts that aren't on the
website get checked for another owner at the same address. Sandusky was sold to Millstone and has AR, so it's linked to
the existing Millstone account instead of getting a new copy. Alliance and Coldwater had no other account at their
address, so I flagged them as Needs Review instead of deactivating them. Being missing from a website isn't enough
to call a facility closed or sold.

Every change goes to a review queue first. Each card shows the website record, the CRM record, why they matched, and
exactly what will change. Nothing is written to the CRM until I approve it. Running the pipeline again doesn't
re-propose anything I've already approved or rejected.

One decision I changed: in the demo I rejected the Grove City rename because it was only "Rehab and" vs
"Rehabilitation &", which felt too small to be worth a write. When I got to Ashland and Arbors Dayton, which are the
same kind of cosmetic change, I realised I was about to be inconsistent. The point of the exercise is for the CRM to
match the website, so I approved all the cosmetic fixes. The app had no way to undo a rejection, so I added a Reopen
button for rejected items. It logs who reopened it and when. I reopened Grove City and approved it. Approved items
can't be reopened because they're already written to the CRM.

**How I used AI.** I used Claude Code as a pair programmer. I had it read the brief and explore the website and the API
read-only first, and list everything that looked wrong before writing any code. I checked that list against the data
myself, then had it build the pipeline and tests against a snapshot of the sandbox. When the right call wasn't obvious,
I made it. For example, it was my decision not to create a second Millstone account for Sandusky, and to flag the
missing facilities instead of deactivating them. I also had it rework the review screen in plain language after I
found the first version too technical, and add the Reopen button when I changed my mind on Grove City. Every change in the CRM went through the review app and was approved by me.

**What I'd build next.** Logins on the review app so more than one person can work the queue, with every decision
tracked by person. Auto-approve for low-risk fixes once we trust them. The same pipeline for other operators. A second
source for ownership changes, like state licensing data. Moving contacts over when accounts are merged as duplicates.
A Slack summary after each daily run.
