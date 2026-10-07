import {describe,it,expect} from 'vitest'
import {render,screen,cleanup} from '@testing-library/react'
import {matchingSentences, SearchHighlight} from './searchExcerpt'
describe('matching sentences',()=>{
 it('keeps only matching sentences, at most three, in document order',()=>{
  expect(matchingSentences('无关。接语第一句。另一段。接语第二句！接语第三句？接语第四句。','接语')).toBe('接语第一句。 … 接语第二句！ … 接语第三句？')
 })
 it('has no arbitrary fallback and matches ASCII without case',()=>{
  expect(matchingSentences('Unrelated. CAT sentence. next.', 'cat')).toBe('CAT sentence.')
  expect(matchingSentences('无关内容。','接语')).toBe('')
 })
 it('highlights literal matches safely',()=>{
  render(<SearchHighlight text='a+b 和 A+B' query='a+b'/>)
  expect(screen.getAllByText(/a\+b/i).every(node=>node.tagName==='MARK')).toBe(true)
  cleanup()
 })
})
