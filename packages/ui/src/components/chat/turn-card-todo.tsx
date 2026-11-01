

import { motion } from 'motion/react';
import { Circle, Ban, CircleCheck } from 'lucide-react';
import { cn } from '../../lib/utils';

import { Spinner } from '../ui/LoadingIndicator';

import { SIZE_CONFIG, type TodoStatus, type TodoItem } from "./turn-card-contracts";

export function TodoStatusIcon({ status }: { status: TodoStatus }) {
  switch (status) {
    case 'pending':
      return <Circle className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-muted-foreground/50")} />
    case 'in_progress':
      return (
        <div className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}>
          <Spinner className={SIZE_CONFIG.spinnerSize} />
        </div>
      )
    case 'completed':
      return <CircleCheck className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-accent")} />
    case 'interrupted':
      return <Ban className={cn(SIZE_CONFIG.iconSize, "shrink-0 text-muted-foreground/50")} />
  }
}

export function TodoRow({ todo }: { todo: TodoItem }) {
  const displayText = todo.status === 'in_progress' && todo.activeForm
    ? todo.activeForm
    : todo.content

  return (
    <div className={cn(
      "flex items-center gap-2 py-0.5 text-muted-foreground",
      SIZE_CONFIG.fontSize,
      todo.status === 'completed' && "opacity-50"
    )}>
      <TodoStatusIcon status={todo.status} />
      <span className={cn(
        "truncate flex-1",
        todo.status === 'completed' && "line-through"
      )}>
        {displayText}
      </span>
    </div>
  )
}

export interface TodoListProps {
  todos: TodoItem[]
}

export function TodoList({ todos }: TodoListProps) {
  if (todos.length === 0) return null

  return (
    <div className="pl-4 pr-2 pt-2.5 pb-1.5 space-y-0.5 border-l-2 border-muted ml-[13px]">
      {/* Header */}
      <div className={cn("text-muted-foreground pb-1", SIZE_CONFIG.fontSize)}>
        Todo List
      </div>
      {/* Todo items */}
      {todos.map((todo, index) => (
        <motion.div
          key={`${todo.content}-${index}`}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: index * 0.03 }}
        >
          <TodoRow todo={todo} />
        </motion.div>
      ))}
    </div>
  )
}
